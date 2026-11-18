import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHost, serve } from "../src/host.js";
import { readLockPid } from "../src/lifecycle.js";
import { type TurnoTool, turnoZod } from "../src/tools.js";
import { upstream } from "../src/upstream.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * Lifecycle tests against a real Google Chrome (ADR 0042): the idle limit of the generated
 * config, the shutdown deadline, and the sweep of a Chrome left behind by a wrapper killed with
 * SIGKILL. Also the host end to end (ADR 0043): a stock tool through the built server, and a
 * test-only turno tool on the same browser context as the stock tools. Every Chrome here runs on a profile inside the test's sandbox HOME, and cleanup only
 * signals processes whose command line names that sandbox, so no other Chrome is touched.
 *
 * Skipped, with the reason in the suite name, when Chrome is not installed or cannot start
 * (or with TURNO_SKIP_CHROME=1).
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");

const CHROME_PATHS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/opt/google/chrome/chrome"],
};

/** Why these tests cannot run here, or undefined when a real Chrome starts. */
function chromeUnavailable(): string | undefined {
  if (process.env.TURNO_SKIP_CHROME === "1") return "TURNO_SKIP_CHROME=1";
  const candidates = CHROME_PATHS[process.platform];
  if (!candidates) return `no process groups to test on ${process.platform}`;
  const exe = candidates.find((p) => existsSync(p));
  if (!exe) return `Google Chrome is not installed (looked for ${candidates.join(", ")})`;
  // Start it once, headless, from a throwaway HOME, so a Chrome that is present but cannot run
  // (a sandbox the host forbids, missing libraries) skips instead of failing every test.
  const home = mkdtempSync(join(tmpdir(), "turno-chrome-probe-"));
  const probe = [
    "const { chromium } = require(process.argv[1]);",
    "chromium.launch({ channel: 'chrome', headless: true, timeout: 20000 })",
    "  .then((b) => b.close()).catch((e) => { console.error(String(e.message).split('\\n')[0]); process.exit(1); });",
  ].join("\n");
  try {
    const core = join(pkg, "node_modules", "patchright-core");
    execFileSync(process.execPath, ["-e", probe, core], { env: { PATH: process.env.PATH, HOME: home }, stdio: ["ignore", "ignore", "pipe"], timeout: 40_000 });
    return undefined;
  } catch (err) {
    const why = String((err as { stderr?: Buffer }).stderr ?? "").trim() || String((err as Error).message);
    return `Chrome at ${exe} did not start: ${why}`;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const reason = chromeUnavailable();
const HEADED = process.platform === "darwin";

beforeAll(() => {
  if (reason) return;
  execFileSync(join(pkg, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json"], { cwd: pkg, stdio: "inherit" });
}, 120_000);

let sb: Sandbox;
const running: StdioClientTransport[] = [];

beforeEach(() => {
  sb = sandbox();
});

afterEach(async () => {
  for (const t of running.splice(0)) await t.close().catch(() => {});
  killSandboxProcesses(sb.home);
  sb.cleanup();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

/** Processes whose command line names the sandbox (only the Chromes these tests started). */
function sandboxProcesses(home: string): { pid: number; ppid: number; pgid: number }[] {
  const out = execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\n")
    .filter((l) => l.includes(home))
    .map((l) => {
      const [pid, ppid, pgid] = l.trim().split(/\s+/).map(Number);
      return { pid: pid!, ppid: ppid!, pgid: pgid! };
    });
}

function killSandboxProcesses(home: string): void {
  for (const p of sandboxProcesses(home)) {
    for (const sig of ["SIGCONT", "SIGKILL"] as const) {
      try {
        process.kill(p.pid, sig);
      } catch {
        /* already gone */
      }
    }
  }
}

function profileDir(id: string): string {
  return join(sb.home, ".local", "share", "turno", "browser", "identities", id);
}

interface Running {
  client: Client;
  transport: StdioClientTransport;
  pid: number;
  stderr: () => string;
}

async function start(id: string, env: Record<string, string> = {}): Promise<Running> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "--identity", id, ...(HEADED ? [] : ["--headless"])],
    env: { ...(sb.env as Record<string, string>), ...env },
    cwd: sb.home,
    stderr: "pipe",
  });
  let err = "";
  transport.stderr?.on("data", (d: Buffer) => {
    err += d.toString();
  });
  running.push(transport);
  const client = new Client({ name: "lifecycle", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport, pid: transport.pid!, stderr: () => err };
}

async function navigate(r: Running): Promise<void> {
  const res = await r.client.callTool({ name: "browser_navigate", arguments: { url: "data:text/html,<title>turno</title>ok" } });
  expect(res.isError ?? false, JSON.stringify(res.content)).toBe(false);
}

function chromePid(id: string): number {
  const pid = readLockPid(profileDir(id));
  expect(pid, "Chrome holds the profile's SingletonLock").toBeDefined();
  return pid!;
}

describe.skipIf(reason !== undefined)(reason ? `real Chrome (skipped: ${reason})` : "real Chrome", () => {
  it(`closes Chrome after the generated idle limit${HEADED ? " while headed" : ""}, and opens it again on the next call`, async () => {
    const r = await start("idle", { TURNO_BROWSER_IDLE: "2s" });
    await navigate(r);
    const first = chromePid("idle");
    expect(alive(first)).toBe(true);
    expect(await waitFor(() => !alive(first), 15_000), "Chrome closed by the idle timer").toBe(true);
    expect(alive(r.pid), "the MCP server keeps running").toBe(true);

    await navigate(r);
    const second = chromePid("idle");
    expect(second).not.toBe(first);
    expect(alive(second)).toBe(true);

    await r.client.close();
    expect(await waitFor(() => !alive(second), 5_000), "Chrome closed with stdin").toBe(true);
  }, 60_000);

  it("stops a Chrome that does not close in time when the server gets SIGTERM", async () => {
    const r = await start("stuck");
    await navigate(r);
    const pid = chromePid("stuck");
    // A Chrome that cannot answer: the graceful close upstream would wait 15 seconds for it.
    process.kill(pid, "SIGSTOP");
    const t0 = Date.now();
    process.kill(r.pid, "SIGTERM");
    expect(await waitFor(() => !alive(r.pid) && !alive(pid), 10_000)).toBe(true);
    // Within the 4 seconds mcpd gives a server between closing stdin and SIGKILL.
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(sandboxProcesses(sb.home)).toEqual([]);
  }, 60_000);

  it("does not let a server killed with SIGKILL block the next start", async () => {
    const r = await start("killed");
    await navigate(r);
    const pid = chromePid("killed");
    process.kill(r.pid, "SIGKILL");
    const next = await start("killed");
    await navigate(next);
    expect(alive(pid)).toBe(false);
    expect(chromePid("killed")).not.toBe(pid);
  }, 60_000);

  it("sweeps an orphaned Chrome of the same identity on start", async () => {
    const r = await start("orphan");
    await navigate(r);
    const pid = chromePid("orphan");
    // Freeze Chrome so it cannot notice its pipe closing, then kill the server the way the
    // MCP SDK does after its grace periods: Chrome is left running with no parent.
    process.kill(pid, "SIGSTOP");
    process.kill(r.pid, "SIGKILL");
    expect(await waitFor(() => !alive(r.pid), 5_000)).toBe(true);
    expect(await waitFor(() => sandboxProcesses(sb.home).some((p) => p.pid === pid && p.ppid !== r.pid), 5_000), "Chrome reparented").toBe(true);

    const next = await start("orphan");
    await navigate(next);
    expect(alive(pid)).toBe(false);
    expect(sandboxProcesses(sb.home).filter((p) => p.pgid === pid)).toEqual([]);
    expect(next.stderr()).toMatch(new RegExp(`closed a Chrome .*pid ${pid}`));
  }, 60_000);

  it("drives stock tools end to end through the host: navigate and snapshot a data: page", async () => {
    const r = await start("e2e");
    const page = "data:text/html,<title>turno host</title><h1>Hello from turno</h1><button>Press me</button>";
    const nav = await r.client.callTool({ name: "browser_navigate", arguments: { url: page } });
    expect(nav.isError ?? false, JSON.stringify(nav.content)).toBe(false);
    expect((nav.content as { text: string }[])[0]!.text).toContain("- Page Title: turno host");
    const snap = await r.client.callTool({ name: "browser_snapshot", arguments: {} });
    expect(snap.isError ?? false, JSON.stringify(snap.content)).toBe(false);
    const text = (snap.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
    expect(text).toMatch(/heading "Hello from turno" \[level=1\] \[ref=e\d+\]/);
    expect(text).toMatch(/button "Press me" \[ref=e\d+\]/);
    expect(chromePid("e2e")).toBeGreaterThan(0);
    await r.client.close();
  }, 60_000);

  it("gives a turno tool the same browser context the stock tools drive", async () => {
    const z = turnoZod();
    const title: TurnoTool = {
      schema: { name: "turno_test_title", title: "Page title (test)", description: "Title of the first page.", inputSchema: z.object({}), type: "readOnly" },
      async handle({ browserContext }) {
        return { content: [{ type: "text", text: `title: ${await browserContext!.pages()[0]!.title()}` }] };
      },
    };
    // Upstream registers a bound browser under the cache dir (HOME on macOS, XDG_CACHE_HOME on
    // Linux; read once per process, and this is the only test here that launches Chrome in
    // process): keep it in the sandbox.
    const saved = { HOME: process.env.HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
    process.env.HOME = sb.home;
    process.env.XDG_CACHE_HOME = join(sb.home, ".cache");
    onTestFinished(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const config = await upstream().tools.resolveCLIConfigForMCP({ browser: "chrome", userDataDir: profileDir("inproc"), headless: !HEADED, outputDir: join(sb.home, "output") }, {});
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await serve(createHost({ config, cliOptions: {}, turnoTools: [title] }), serverSide);
    const client = new Client({ name: "inproc", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      const nav = await client.callTool({ name: "browser_navigate", arguments: { url: "data:text/html,<title>same context</title>ok" } });
      expect(nav.isError ?? false, JSON.stringify(nav.content)).toBe(false);
      const pid = chromePid("inproc");
      expect(await client.callTool({ name: "turno_test_title", arguments: {} })).toEqual({ content: [{ type: "text", text: "title: same context" }] });
      await client.close();
      expect(await waitFor(() => !alive(pid), 10_000), "Chrome closed with the session").toBe(true);
    } finally {
      await client.close().catch(() => {});
    }
  }, 60_000);
});

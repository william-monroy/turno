import { type ChildProcess, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Demo, demoEnv, runDemo, startDemo } from "../src/cli/commands/demo.js";
import { main } from "../src/cli/main.js";
import { profileToken } from "../src/mcpd/tokens.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";
import { killAndWait, waitFor } from "./helpers/wait.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(PKG, "test/fixtures/fixture-server.mjs");
const DIST_MAIN = join(PKG, "dist/cli/main.js");
const BUILT = existsSync(join(PKG, "dist/cli/commands/demo.js")) && existsSync(join(PKG, "dist/demo/server.js"));

let sb: Sandbox;
let tmp: string;
let demos: Demo[] = [];
let children: ChildProcess[] = [];

beforeEach(() => {
  sb = sandbox();
  // Where the demo puts its HOME: a folder of this test, not the OS temp dir.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "turno-demo-test-")));
});
afterEach(async () => {
  for (const c of children) await killAndWait(c);
  for (const d of demos) await d.stop();
  children = [];
  demos = [];
  rmSync(tmp, { recursive: true, force: true });
  sb.cleanup();
});

const server = { command: process.execPath, args: [FIXTURE] };

async function start(): Promise<Demo> {
  const io = fakeIo(sb.env);
  const d = await startDemo(io, { tmp, server, entry: DIST_MAIN });
  demos.push(d);
  return d;
}

async function rpc(port: number, server: string, token: string, body: unknown, session?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp/${server}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-turno-profile": "work",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("turno demo", () => {
  it("builds a throwaway HOME with two profiles, a rule, a gateway and the status line", async () => {
    const d = await start();
    expect(d.home.startsWith(`${tmp}/turno-demo-`)).toBe(true);
    expect(existsSync(join(d.home, ".local/bin/claude-work"))).toBe(true);
    expect(existsSync(join(d.home, ".local/bin/claude-personal"))).toBe(true);
    expect(readFileSync(join(d.home, ".local/bin/turno"), "utf8")).toContain(DIST_MAIN);
    const cfg = readFileSync(join(d.home, ".config/turno/config.toml"), "utf8");
    expect(cfg).toContain('default = "personal"');
    expect(cfg).toContain('path = "~/code/acme"');
    expect(cfg).toContain(`port = ${d.port}`);
    // mcp sync pointed the profiles at the demo gateway.
    const work = JSON.parse(readFileSync(join(d.home, ".claude-work/.claude.json"), "utf8")) as {
      mcpServers: Record<string, { url: string }>;
    };
    expect(Object.keys(work.mcpServers).sort()).toEqual(["docs", "issues"]);
    expect(work.mcpServers.issues!.url).toBe(`http://127.0.0.1:${d.port}/mcp/issues`);
    // The status line, rendered for each profile.
    expect(d.statusLines.join("\n")).toContain("work");
    expect(d.statusLines.join("\n")).toContain("personal");
    // The gateway answers a real MCP session with the profile's token.
    const master = readFileSync(join(d.home, ".local/state/turno/mcpd.token"), "utf8").trim();
    const init = await rpc(d.port, "issues", profileToken(master, "work"), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect(init.status).toBe(200);
    await init.body?.cancel();
    // The demo env never names the real HOME, the sandbox HOME of this test.
    expect(Object.values(d.env).join(" ")).not.toContain(sb.home);
    expect(readdirSync(sb.home)).toEqual([]);

    await d.stop();
    expect(existsSync(d.home)).toBe(false);
    await expect(fetch(`http://127.0.0.1:${d.port}/status`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });

  it("keeps only safe variables in the demo env", () => {
    const env = demoEnv(
      {
        PATH: "/usr/bin",
        HOME: "/real",
        TERM: "xterm",
        CLAUDE_CONFIG_DIR: "/real/.claude-x",
        TURNO_MCPD_TOKEN: "t",
        XDG_CONFIG_HOME: "/real/.config",
        ZDOTDIR: "/real",
      },
      "/demo",
    );
    expect(env.HOME).toBe("/demo");
    expect(env.PATH).toBe("/demo/.local/bin:/usr/bin");
    expect(env.TERM).toBe("xterm");
    for (const k of ["CLAUDE_CONFIG_DIR", "TURNO_MCPD_TOKEN", "XDG_CONFIG_HOME", "ZDOTDIR"])
      expect(env[k]).toBeUndefined();
  });

  it("runs a command inside the demo, passes its exit code on and cleans up", async () => {
    const marker = join(tmp, "seen-home");
    const io = fakeIo(sb.env);
    const code = await runDemo(
      ["--", "sh", "-c", `echo "$HOME" > "${marker}"; test -x "$HOME/.local/bin/claude-work" && exit 3`],
      io,
      { tmp, server, entry: DIST_MAIN },
    );
    expect(code).toBe(3);
    const seen = readFileSync(marker, "utf8").trim();
    expect(seen.startsWith(`${tmp}/turno-demo-`)).toBe(true);
    expect(existsSync(seen)).toBe(false);
    expect(readdirSync(sb.home)).toEqual([]);
  });

  it("without a terminal it prints what it set up and ends, removing everything", async () => {
    const io = fakeIo(sb.env);
    expect(await runDemo([], io, { tmp, server, entry: DIST_MAIN })).toBe(0);
    const text = io.lines.join("\n");
    expect(text).toMatch(/^turno demo {2}a throwaway HOME at /m);
    expect(text).toMatch(/^ {2}profiles {2}work for ~\/code\/acme, personal for every other folder/m);
    expect(text).toMatch(/^ {2}gateway {3}mcpd on 127\.0\.0\.1:\d+/m);
    expect(text).toContain("so the demo ends now");
    expect(text).not.toContain("\x1b[");
    expect(io.errors.join("\n")).toMatch(/stopped mcpd and removed/);
    expect(readdirSync(tmp).filter((n) => n.startsWith("turno-demo-"))).toEqual([]);
  });

  it("with --keep and no terminal it waits until stopped (Ctrl-C), then removes everything", async () => {
    const io = fakeIo(sb.env);
    const stop = new AbortController();
    const done = runDemo(["--keep"], io, { tmp, server, entry: DIST_MAIN, signal: stop.signal });
    await waitFor(() => io.lines.some((l) => l.includes("Ctrl-C")), "the demo to be ready", { timeout: 20_000 });
    const home = readdirSync(tmp).find((n) => n.startsWith("turno-demo-"));
    expect(home).toBeDefined();
    stop.abort();
    expect(await done).toBe(0);
    expect(readdirSync(tmp).filter((n) => n.startsWith("turno-demo-"))).toEqual([]);
  });

  it("removes the HOME of a demo whose process died", async () => {
    const stale = join(tmp, "turno-demo-old");
    mkdirSync(join(stale, ".config"), { recursive: true });
    writeFileSync(join(stale, ".turno-demo"), "999999\n");
    const kept = join(tmp, "turno-demo-alive");
    mkdirSync(kept);
    writeFileSync(join(kept, ".turno-demo"), `${process.pid}\n`);
    const other = join(tmp, "turno-demo-not-ours");
    mkdirSync(other);
    await start();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it("refuses arguments it does not know", async () => {
    const io = fakeIo(sb.env);
    expect(await main(["demo", "--nope"], io)).toBe(2);
    expect(readdirSync(tmp)).toEqual([]);
  });
});

/** The built CLI as its own process: real signals, and a copy laid out like npx's cache. */
describe.skipIf(!BUILT)("turno demo (built CLI)", () => {
  function launch(entry: string, args: string[]): { child: ChildProcess; out: () => string } {
    let text = "";
    const child = spawn(process.execPath, [entry, "demo", ...args], {
      env: { PATH: sb.env.PATH, HOME: sb.home, TMPDIR: tmp, TURNO_NO_UPDATE_CHECK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (b: Buffer) => (text += b.toString()));
    child.stderr!.on("data", (b: Buffer) => (text += b.toString()));
    children.push(child);
    return { child, out: () => text };
  }
  const exited = (c: ChildProcess) =>
    new Promise<number | null>((r) => (c.exitCode !== null ? r(c.exitCode) : c.once("exit", (code) => r(code))));

  it("ends by itself without a terminal, so scripts and agents can run it", async () => {
    const { child, out } = launch(DIST_MAIN, []);
    expect(await exited(child)).toBe(0);
    expect(out()).toContain("so the demo ends now");
    expect(readdirSync(tmp).filter((n) => n.startsWith("turno-demo-"))).toEqual([]);
  });

  it("with --keep, Ctrl-C stops mcpd and removes the throwaway HOME", async () => {
    const { child, out } = launch(DIST_MAIN, ["--keep"]);
    await waitFor(() => out().includes("Ctrl-C"), "the demo to be ready", { timeout: 20_000 });
    const home = /HOME at (\S+)/.exec(out())?.[1];
    expect(home && existsSync(home)).toBeTruthy();
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(out())?.[1]);
    child.kill("SIGINT");
    expect(await exited(child)).toBe(0);
    expect(existsSync(home!)).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    expect(readdirSync(sb.home)).toEqual([]);
  });

  it("works from a copy in npx's cache, where profile add refuses", async () => {
    const pkg = join(tmp, "npm-cache/_npx/0123abcd/node_modules/turno-cli");
    mkdirSync(pkg, { recursive: true });
    cpSync(join(PKG, "dist"), join(pkg, "dist"), { recursive: true });
    cpSync(join(PKG, "package.json"), join(pkg, "package.json"));
    symlinkSync(join(PKG, "node_modules"), join(pkg, "node_modules"));
    const { child, out } = launch(join(pkg, "dist/cli/main.js"), [
      "--",
      "sh",
      "-c",
      "turno profile list && turno mcp list",
    ]);
    expect(await exited(child)).toBe(0);
    expect(out()).toMatch(/personal/);
    expect(out()).toMatch(/issues/);
    expect(readdirSync(tmp).filter((n) => n.startsWith("turno-demo-"))).toEqual([]);
  });
});

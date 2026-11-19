// Starts the built turno-browser-mcp for one configuration on a throwaway identity in a
// throwaway HOME, and wraps its MCP client so every tool call is counted. Nothing outside that
// HOME is read or written: the environment is built from scratch (PATH and TMPDIR only), and
// cleanup signals only processes whose command line names the throwaway HOME.

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { estimateTokens } from "./stats.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DEFAULT_BIN = join(ROOT, "packages/browser/dist/bin/mcp.js");
const require = createRequire(join(ROOT, "packages/browser/package.json"));
const sdk = (p) => import(pathToFileURL(require.resolve(`@modelcontextprotocol/sdk/${p}`)).href);

/** The identity every run uses. */
const IDENTITY = "eval";

/** Servers still running, stopped on Ctrl-C or SIGTERM so no Chrome outlives the script. */
const live = new Set();
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, async () => {
    await Promise.allSettled([...live].map((s) => s.stop()));
    process.exit(130);
  });
}

/** Thrown when the server under test does not accept a configuration's key or flag. */
export class UnsupportedConfig extends Error {}

/** Text of an MCP tool result. */
function textOf(res) {
  return (res?.content ?? []).map((c) => c.text ?? "").join("\n");
}

/** Bytes of a result as the model would read them: text parts, and the data of image parts. */
function resultBytes(res) {
  let n = 0;
  for (const c of res?.content ?? []) {
    if (typeof c.text === "string") n += Buffer.byteLength(c.text);
    else if (typeof c.data === "string") n += c.data.length;
  }
  return n;
}

/** Versions of the build a binary belongs to: turno-browser and the patchright-core it loads. */
export function buildVersions(bin) {
  const pkgDir = join(dirname(bin), "..", "..");
  const read = (f) => {
    try {
      return JSON.parse(readFileSync(f, "utf8")).version;
    } catch {
      return undefined;
    }
  };
  let patchright;
  try {
    patchright = read(createRequire(join(pkgDir, "package.json")).resolve("patchright-core/package.json"));
  } catch {
    patchright = undefined;
  }
  return { turnoBrowser: read(join(pkgDir, "package.json")), patchrightCore: patchright };
}

/** Every tool call of one run: what the model would have sent and read. */
export class Agent {
  constructor(client) {
    this.client = client;
    this.steps = [];
  }

  /** Calls a tool. A tool error is a result (agents read it and go on), not an exception. */
  async call(tool, args = {}) {
    const t0 = performance.now();
    let res;
    try {
      res = await this.client.callTool({ name: tool, arguments: args }, undefined, { timeout: 90_000 });
    } catch (err) {
      res = { isError: true, content: [{ type: "text", text: String(err?.message ?? err) }] };
    }
    const text = textOf(res);
    const step = {
      tool,
      ms: Math.round(performance.now() - t0),
      bytes: resultBytes(res),
      error: Boolean(res.isError),
    };
    this.steps.push(step);
    return { text, error: step.error };
  }

  /** Like `call`, but a tool error throws: for steps a task cannot go on without. */
  async must(tool, args = {}) {
    const r = await this.call(tool, args);
    if (r.error) throw new Error(`${tool} failed: ${r.text.split("\n").slice(0, 3).join(" ")}`);
    return r.text;
  }

  summary() {
    const bytes = this.steps.reduce((n, s) => n + s.bytes, 0);
    return {
      calls: this.steps.length,
      errors: this.steps.filter((s) => s.error).length,
      bytes,
      tokens: estimateTokens(bytes),
    };
  }
}

function ps() {
  return new Promise((resolveOut) => {
    execFile("ps", ["-A", "-ww", "-o", "pid=,ppid=,rss=,command="], { maxBuffer: 64 * 1024 * 1024 }, (err, out) =>
      resolveOut(err ? "" : out),
    );
  });
}

/** Processes of a run: the server, everything below it, and anything naming its HOME. */
export function runProcesses(psOutput, rootPid, home) {
  const rows = psOutput
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rssKiB: Number(m[3]), command: m[4] }));
  const children = new Map();
  for (const r of rows) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r]);
  const picked = new Map();
  const walk = (pid) => {
    for (const c of children.get(pid) ?? []) {
      if (picked.has(c.pid)) continue;
      picked.set(c.pid, c);
      walk(c.pid);
    }
  };
  const root = rows.find((r) => r.pid === rootPid);
  if (root) picked.set(root.pid, root);
  walk(rootPid);
  if (home) for (const r of rows) if (r.command.includes(home) && !picked.has(r.pid)) picked.set(r.pid, r);
  return [...picked.values()];
}

/**
 * Samples the resident memory of a run's processes every `intervalMs` until stopped, and keeps
 * the peak of their sum. RSS counts shared pages once per process, so the sum overstates real
 * pressure somewhat, the same way for every configuration.
 */
export function memorySampler(rootPid, home, intervalMs = 200) {
  let peakKiB = 0;
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const procs = runProcesses(await ps(), rootPid, home);
      const kib = procs.reduce((n, p) => n + p.rssKiB, 0);
      if (kib > peakKiB) peakKiB = kib;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return Math.round(peakKiB / 1024);
    },
  };
}

async function killHomeProcesses(home) {
  for (const p of runProcesses(await ps(), -1, home)) {
    for (const sig of ["SIGCONT", "SIGKILL"]) {
      try {
        process.kill(p.pid, sig);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Starts the server for a configuration. Writes the configuration's identity.json keys with
 * the build's own settings module first, so a key that build does not know is reported as
 * unsupported (`UnsupportedConfig`) instead of being silently ignored.
 */
export async function startServer(config, { headed = false } = {}) {
  const bin = config.bin ?? DEFAULT_BIN;
  if (!existsSync(bin)) throw new Error(`${bin} does not exist; run pnpm build first`);
  const home = realpathSync(mkdtempSync(join(tmpdir(), "turno-eval-")));
  const env = { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir(), ...config.env };
  const cleanupHome = () => rmSync(home, { recursive: true, force: true });
  if (config.identity && Object.keys(config.identity).length) {
    const settings = await import(pathToFileURL(join(dirname(bin), "..", "settings.js")).href);
    try {
      settings.writeIdentitySettings(IDENTITY, config.identity, env);
    } catch (err) {
      cleanupHome();
      const msg = String(err?.message ?? err);
      if (/unknown key/.test(msg)) throw new UnsupportedConfig(`${config.needs ?? "a newer turno-browser"}: ${msg}`);
      throw err;
    }
  }
  const { Client } = await sdk("client/index.js");
  const { StdioClientTransport } = await sdk("client/stdio.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "--identity", IDENTITY, ...(headed ? [] : ["--headless"]), ...(config.args ?? [])],
    env,
    cwd: home,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  const client = new Client({ name: "turno-browser-eval", version: "0.0.0" });
  try {
    await client.connect(transport);
  } catch (err) {
    await killHomeProcesses(home);
    cleanupHome();
    const why = stderr.trim().split("\n").slice(-3).join(" ") || String(err?.message ?? err);
    if (/unknown option|unknown argument/i.test(why)) throw new UnsupportedConfig(`${config.needs ?? "flags"}: ${why}`);
    throw new Error(`the server did not start: ${why}`);
  }
  let stopped = false;
  const handle = {
    client,
    home,
    bin,
    pid: transport.pid,
    agent: () => new Agent(client),
    stderrTail: () => stderr,
    async stop() {
      if (stopped) return;
      stopped = true;
      await client.close().catch(() => undefined);
      // The server closes Chrome on its way out; give it a moment, then make sure.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && runProcesses(await ps(), -1, home).length) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await killHomeProcesses(home);
      cleanupHome();
      live.delete(handle);
    },
  };
  live.add(handle);
  return handle;
}

/**
 * Launches Chrome before anything is measured and reads its user agent: the launch is not part
 * of any task, and the version goes in the report.
 */
export async function warmUp(client, blankUrl) {
  // A page on 127.0.0.1 is a secure context, where client hints (the full version) are readable.
  if (blankUrl) {
    const nav = await client.callTool({ name: "browser_navigate", arguments: { url: blankUrl } });
    if (nav.isError) throw new Error(`the browser did not start: ${textOf(nav).split("\n").slice(0, 3).join(" ")}`);
  }
  // The user agent string carries a reduced version (157.0.0.0); client hints carry the full one.
  const fn =
    "async () => [navigator.userAgent, navigator.userAgentData ? (await navigator.userAgentData.getHighEntropyValues(['uaFullVersion'])).uaFullVersion : ''].join(' | ')";
  const res = await client.callTool({ name: "browser_evaluate", arguments: { function: fn } });
  if (res.isError) throw new Error(`the browser did not start: ${textOf(res).split("\n").slice(0, 3).join(" ")}`);
  const [ua = "", full = ""] = (/"([^"]*Mozilla[^"]*)"/.exec(textOf(res))?.[1] ?? "").split(" | ");
  const m = /(HeadlessChrome|Chrome|Firefox)\/([\d.]+)/.exec(ua);
  const name = m?.[1] === "HeadlessChrome" ? "Chrome" : m?.[1];
  return { userAgent: ua, browser: m ? `${name} ${full || m[2]}` : "unknown" };
}

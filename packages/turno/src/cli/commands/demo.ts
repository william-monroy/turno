import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Journal } from "../../core/journal.js";
import { paths } from "../../core/paths.js";
import { literal, setValue } from "../../core/toml-edit.js";
import type { RunningDaemon } from "../../mcpd/daemon.js";
import { parseFlags } from "../args.js";
import { type Command, type Io, paint } from "../io.js";
import { findOnPath } from "../launchers.js";
import { setupProfiles } from "./setup.js";
import { pidAlive } from "../../core/fsutil.js";

/**
 * `turno demo` (ADR 0030): turno in a throwaway HOME under the OS temp folder, with two Claude
 * Code profiles, a folder rule, two MCP servers behind an mcpd on a free port, and the status
 * line. It never reads or writes the person's own HOME, never signs in, needs no global install
 * (it works from npx's cache), and always stops mcpd and removes the folder when it ends.
 */

const PREFIX = "turno-demo-";
/** A file in every demo HOME with the PID of the demo that owns it. */
const OWNER = ".turno-demo";

/** Variables a demo session keeps from the caller: terminal and locale, never config or tokens. */
const KEEP = ["PATH", "TERM", "COLORTERM", "TERM_PROGRAM", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "USER", "LOGNAME", "SHELL", "COLUMNS", "NO_COLOR"];

/** The env of everything that runs inside the demo: the demo HOME, its launchers first on PATH. */
export function demoEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of KEEP) if (base[k] !== undefined) env[k] = base[k];
  env.HOME = home;
  env.PATH = `${join(home, ".local", "bin")}:${base.PATH ?? "/usr/bin:/bin"}`;
  env.TURNO_NO_UPDATE_CHECK = "1";
  return env;
}

export interface DemoOptions {
  /** Folder that holds the demo HOME (default: the OS temp folder). */
  tmp?: string;
  /** The MCP server command; the server name is added as its last argument. */
  server?: { command: string; args: string[] };
  /** turno's CLI entry (main.js) that the demo's `turno` runs. */
  entry?: string;
  /** Stops a demo that waits for Ctrl-C (tests). */
  signal?: AbortSignal;
}

export interface Demo {
  home: string;
  env: NodeJS.ProcessEnv;
  port: number;
  /** The status line of each profile, as Claude Code would draw it. */
  statusLines: string[];
  stop(): Promise<void>;
}

const PROFILES = [
  { name: "work", color: "violet", folder: "code/acme" },
  { name: "personal", color: "green", folder: "code/personal-site" },
] as const;

const SERVERS = ["docs", "issues"] as const;

/** Remove demo HOMEs left by a demo that was killed (SIGKILL, power loss): their owner is gone. */
function removeStale(tmp: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(tmp);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.startsWith(PREFIX)) continue;
    const dir = join(tmp, n);
    let pid = 0;
    try {
      pid = Number.parseInt(readFileSync(join(dir, OWNER), "utf8"), 10);
    } catch {
      continue; // not made by turno demo: never touched
    }
    if (pid > 0 && !pidAlive(pid)) rmSync(dir, { recursive: true, force: true });
  }
}

/** An Io that keeps the output of the steps the demo runs for itself. */
function quietIo(env: NodeJS.ProcessEnv): Io & { text: string[] } {
  const text: string[] = [];
  return { env, isTty: false, text, out: (l = "") => text.push(l), err: (l = "") => text.push(l) };
}

/** A single-quoted POSIX shell word. */
const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

function write(file: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
}

function manifestText(server: { command: string; args: string[] }): string {
  const lines = ["# turno demo: two MCP servers behind the gateway. Each starts on first use and stops when idle.", ""];
  for (const name of SERVERS) {
    lines.push(`[server.${name}]`, `command = ${literal(server.command)}`, `args = ${literal([...server.args, name])}`, 'scope = "shared"', "");
  }
  // The same server, another account: the work profile gets its own process.
  lines.push("[server.issues.variant.work]", 'env = { DEMO_ACCOUNT = "work" }', "");
  return lines.join("\n");
}

function configText(): string {
  const lines = ["# turno demo: ~/code/acme opens with the work profile, every other folder with personal.", 'default = "personal"', 'icons = "unicode"', ""];
  for (const p of PROFILES) lines.push(`[profiles.${p.name}]`, `color = "${p.color}"`, "");
  lines.push("[[projects]]", 'path = "~/code/acme"', 'profile = "work"', "");
  return lines.join("\n");
}

function samplePayload(home: string, folder: string, now: number): Record<string, unknown> {
  return {
    session_id: "turno-demo",
    model: { display_name: "Opus" },
    workspace: { current_dir: join(home, folder), project_dir: join(home, folder) },
    cost: { total_cost_usd: 0.42, total_lines_added: 120, total_lines_removed: 18 },
    context_window: { used_percentage: 23, total_input_tokens: 46_000, context_window_size: 200_000 },
    rate_limits: { five_hour: { used_percentage: 38, resets_at: Math.trunc(now) + 2 * 3600 }, seven_day: { used_percentage: 12, resets_at: Math.trunc(now) + 4 * 86400 } },
  };
}

/** Build the demo HOME and start its gateway. The caller must call stop(). */
export async function startDemo(io: Io, opts: DemoOptions = {}): Promise<Demo> {
  const tmp = realpathSync(opts.tmp ?? tmpdir());
  removeStale(tmp);
  const home = mkdtempSync(join(tmp, PREFIX));
  writeFileSync(join(home, OWNER), `${process.pid}\n`);
  let daemon: RunningDaemon | undefined;
  let stopped = false;
  // Last resort if the process ends without stop() (an uncaught error): the files still go.
  const onExit = () => rmSync(home, { recursive: true, force: true });
  process.on("exit", onExit);
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await daemon?.stop();
    } finally {
      rmSync(home, { recursive: true, force: true });
      process.off("exit", onExit);
    }
  };
  try {
    const env = demoEnv(io.env, home);
    const p = paths(env);
    const here = dirname(fileURLToPath(import.meta.url));
    const entry = opts.entry ?? join(here, "..", "main.js");
    const server = opts.server ?? { command: process.execPath, args: [join(here, "..", "..", "demo", "server.js")] };
    const shim = join(p.bin, "turno");
    write(shim, `#!/bin/sh\n# turno demo: the turno that started this demo\nexec ${sq(process.execPath)} ${sq(entry)} "$@"\n`, 0o755);
    write(join(home, ".zshrc"), "# turno demo\nPROMPT='%F{magenta}turno demo%f %~ %# '\n");
    write(join(home, ".bashrc"), "# turno demo\nPS1='turno demo \\w \\$ '\n");
    // The hub settings.json is linked into every profile, so both draw turno's status line.
    write(join(p.hub, "settings.json"), `${JSON.stringify({ statusLine: { type: "command", command: `${JSON.stringify(shim)} statusline`, padding: 0 } }, null, 2)}\n`);
    for (const f of PROFILES) mkdirSync(join(home, f.folder), { recursive: true });
    write(p.mcpFile, manifestText(server));
    write(p.configFile, configText());
    const quiet = quietIo(env);
    setupProfiles(
      PROFILES.map((f) => f.name),
      quiet,
      { turno: sq(shim), journal: new Journal(env, "demo setup") },
    );

    const { startDaemon } = await import("../../mcpd/daemon.js");
    daemon = await startDaemon({ env, port: 0 });
    const port = daemon.port;
    write(p.configFile, setValue(configText(), "mcpd", "port", port));
    const { command: mcp } = await import("./mcp.js");
    if ((await mcp.run(["sync"], quiet)) !== 0) throw new Error(`mcp sync failed in the demo:\n${quiet.text.join("\n")}`);

    // The status line without its background workers: a known plan, a gateway known to answer.
    const now = Date.now() / 1000;
    write(join(p.planDir, "work"), "max");
    write(join(p.planDir, "personal"), "pro");
    write(join(p.state, "cache", "mcpd-health.json"), JSON.stringify({ ok: true, port, checked_at: Math.trunc(now) + 10 * 365 * 86400 }));
    write(join(home, "statusline.json"), `${JSON.stringify(samplePayload(home, PROFILES[0].folder, now), null, 2)}\n`);
    const { collect } = await import("./statusline.js");
    const { render } = await import("../../statusline/render.js");
    const statusLines = PROFILES.map((f) =>
      render(collect(samplePayload(home, f.folder, now), { ...env, CLAUDE_CONFIG_DIR: join(home, `.claude-${f.name}`) }, now, [])).replace(/\n$/, ""),
    );
    return { home, env, port, statusLines, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: it strips ANSI color codes, which start with ESC.
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function intro(io: Io, d: Demo): void {
  const color = io.isTty && !io.env.NO_COLOR;
  io.out(`${paint(io, "turno demo", "1")}: a throwaway HOME at ${d.home}`);
  io.out("  Claude Code profiles work (for ~/code/acme) and personal (every other folder)");
  io.out(`  mcpd on 127.0.0.1:${d.port} with two MCP servers (docs, issues), synced into both profiles`);
  io.out("  the status line Claude Code draws for each profile:");
  io.out("");
  for (const l of d.statusLines) io.out(color ? l : strip(l));
  io.out("");
  io.out("Try:");
  const rows: [string, string][] = [
    ["turno status", "the one-screen summary"],
    ["turno profile which ~/code/acme", "which account a folder opens with, and why"],
    ["turno mcp list", "the servers behind the gateway"],
    ["cat ~/.claude-work/.claude.json", "the gateway entries turno mcp sync wrote"],
    ["CLAUDE_CONFIG_DIR=~/.claude-work turno statusline < ~/statusline.json", "draw the work status line yourself"],
    ["turno undo --list", "every change turno made, each one undoable"],
  ];
  if (findOnPath("claude", d.env)) rows.push(["cd ~/code/acme && turno auto mcp list", "Claude Code connects to both servers through mcpd (no sign-in)"]);
  const w = Math.max(...rows.map(([c]) => c.length));
  for (const [c, why] of rows) io.out(`  ${c.padEnd(w)}  ${why}`);
  io.out("Nothing here reads or changes your own HOME, and nothing signs in.");
}

const USAGE = `Usage: turno demo [-- <command> [args...]]

Try turno without touching your setup. The demo builds a throwaway HOME under the temp folder
with two Claude Code profiles (work, personal), a folder rule, two MCP servers behind an mcpd on
a free port, and the status line. It never signs in.

In a terminal it opens a shell in that HOME; exit the shell to end the demo. With a command after
--, it runs that command in the demo instead. Otherwise it waits for Ctrl-C. Either way it stops
mcpd and removes the folder when it ends. Works from npx: npx turno-cli demo`;

/** Run the demo: a shell, a command, or a wait for Ctrl-C. Returns the exit code. */
export async function runDemo(args: string[], io: Io, opts: DemoOptions = {}): Promise<number> {
  const end = args.indexOf("--");
  parseFlags(end < 0 ? args : args.slice(0, end), {}, 0);
  const cmd = end < 0 ? [] : args.slice(end + 1);
  const d = await startDemo(io, opts);
  let child: ChildProcess | undefined;
  let wake: (() => void) | undefined;
  // Ctrl-C reaches a child in the foreground from the terminal; the demo waits for it to end.
  // SIGTERM and SIGHUP (the terminal closed) end the child, then the demo cleans up.
  const onSignal = (sig: NodeJS.Signals) => {
    if (!child) return wake?.();
    if (sig === "SIGINT") return;
    child.kill(cmd.length ? sig : "SIGHUP");
    setTimeout(() => child?.kill("SIGKILL"), 3000).unref();
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of signals) process.on(s, onSignal);
  const onAbort = () => wake?.();
  opts.signal?.addEventListener("abort", onAbort);
  try {
    if (cmd.length) {
      io.err(`turno demo: running ${cmd.join(" ")} in a throwaway HOME at ${d.home} (mcpd on 127.0.0.1:${d.port})`);
      return await runChild(cmd[0]!, cmd.slice(1), d, (c) => (child = c));
    }
    intro(io, d);
    io.out("");
    if (io.ask) {
      io.out("Opening a shell in the demo HOME. Type exit to end the demo; it then stops mcpd and removes everything.");
      const shell = d.env.SHELL || "/bin/sh";
      return await runChild(shell, ["-i"], d, (c) => (child = c));
    }
    io.out(`From another terminal: export HOME=${d.home} PATH=${d.home}/.local/bin:$PATH`);
    io.out("Press Ctrl-C to stop the demo and remove it.");
    await new Promise<void>((resolve) => {
      wake = resolve;
      if (opts.signal?.aborted) resolve();
    });
    return 0;
  } finally {
    for (const s of signals) process.off(s, onSignal);
    opts.signal?.removeEventListener("abort", onAbort);
    await d.stop();
    io.err(`turno demo: stopped mcpd and removed ${d.home}`);
  }
}

function runChild(file: string, args: string[], d: Demo, track: (c: ChildProcess) => void): Promise<number> {
  return new Promise((resolve) => {
    const c = spawn(file, args, { stdio: "inherit", env: d.env, cwd: d.home });
    track(c);
    c.once("error", (err) => {
      process.stderr.write(`turno demo: cannot run ${file}: ${err.message}\n`);
      resolve(127);
    });
    c.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + (signalNumber(signal) ?? 1) : 1)));
  });
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  return ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[signal];
}

export const command: Command = {
  summary: "try turno in a throwaway HOME: two profiles, a gateway and the status line (removed on exit)",
  usage: USAGE,
  run: (args, io) => runDemo(args, io),
};

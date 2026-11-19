import { closeSync, openSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ensurePrivateDir, writePrivateFile } from "turno-core/paths";
import { type ProcTable, pidAlive } from "turno-core/process";
import type { Manifest, StdioServer } from "../../core/manifest.js";
import { paths } from "../../core/paths.js";
import { UsageError } from "../io.js";

/**
 * The session of `turno browser do`. Each command is one call through mcpd, the way an agent's
 * tool call goes, so the identity's browser, its tab locks ("sharing": "tabs") or its one-session
 * lease ("sharing": "session"), humanize and recordings treat it like an agent session.
 *
 * What makes several commands one session is the mcpd session itself: the first command opens
 * one and saves its id in a private file, the next commands reconnect to it instead of opening
 * another, and mcpd keeps giving the browser the same `io.turno/session` id, so the commands keep
 * their tab. mcpd drops a session when the process named by its X-Turno-Pid header exits, so that
 * header names the process the commands belong to (`sessionOwner`): the coding agent that runs
 * them through a shell, or the terminal's shell. `turno browser do <id> end` ends it at once.
 */

/** The process a CLI session belongs to: it lives as long as this process does. */
export interface Owner {
  pid: number;
  /** The process's command line, for messages (`claude`, `-zsh`). */
  command: string;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh", "mksh", "ash", "csh", "tcsh"]);
const WRAPPERS = new Set(["env", "timeout", "gtimeout", "nice", "nohup", "stdbuf", "time", "xargs"]);
const RUNNERS = /^(pnpm|pnpx|npm|npx|yarn|bunx|corepack)(\.c?js)?$|^(npm|npx)-cli\.js$/;

function words(command: string): string[] {
  return command.trim().split(/\s+/);
}

function program(word: string | undefined): string {
  return basename(word ?? "").replace(/^-/, "");
}

/**
 * True for a process that only passes a command on: a shell started for one command (`zsh -c`,
 * `bash -lc`, as coding agents run each command), a wrapper (`env`, `timeout`) or a package
 * runner (`pnpm exec`). An interactive or login shell (`-zsh`, `bash`) and a script's shell
 * (`bash script.sh`) are not: a session belongs to them.
 */
export function passesOn(command: string): boolean {
  const [first, ...rest] = words(command);
  const name = program(first);
  if (SHELLS.has(name)) return rest.some((w) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
  if (WRAPPERS.has(name)) return true;
  if (RUNNERS.test(name)) return true;
  if (name === "node" || name === "bun") return RUNNERS.test(program(rest[0]));
  return false;
}

/**
 * The owner of a CLI session started from `start` (the parent of this process). An agent that a
 * turno launcher started names itself in TURNO_SESSION_PID (`agent`), the pid its own MCP
 * sessions send: when that process is up the tree, it is the owner. Otherwise the first process
 * up the tree that does not only pass a command on: inside Claude Code or Codex that is the
 * agent, so its commands share one session; in a terminal it is the shell. Without a process
 * table (no `ps`), the parent itself.
 */
export function sessionOwner(table: ProcTable | undefined, start: number = process.ppid, agent?: number): Owner {
  if (table && agent && agent > 1) {
    for (let pid = start, hops = 0; hops < 32; hops++) {
      const info = table.get(pid);
      if (!info) break;
      if (pid === agent) return { pid, command: info.command };
      if (info.ppid <= 1 || info.ppid === pid) break;
      pid = info.ppid;
    }
  }
  let pid = start;
  for (let hops = 0; table && hops < 16; hops++) {
    const info = table.get(pid);
    if (!info) break;
    const parent = table.get(info.ppid);
    if (!passesOn(info.command) || info.ppid <= 1 || !parent) return { pid, command: info.command };
    pid = info.ppid;
  }
  return { pid: start, command: table?.get(start)?.command ?? "" };
}

/** A short name for the owner in a message: its program (`claude`, `zsh`). */
export function ownerName(owner: Owner): string {
  const [first, second] = words(owner.command);
  const name = program(first);
  if ((name === "node" || name === "bun") && second) return program(second).replace(/\.c?js$/, "");
  return name || `pid ${owner.pid}`;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** `--session <name>`, else TURNO_BROWSER_SESSION, else "default". */
export function sessionName(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  const name = flag ?? (env.TURNO_BROWSER_SESSION || "default");
  if (!NAME.test(name))
    throw new UsageError(
      `session name "${name}" must be 1 to 40 lowercase letters, digits, "-" or "_" (--session or TURNO_BROWSER_SESSION)`,
    );
  return name;
}

/** What a CLI session saves between commands. */
export interface SavedSession {
  v: 1;
  identity: string;
  server: string;
  profile: string;
  /** mcpd's port when the session opened: another port means another mcpd. */
  port: number;
  /** The Mcp-Session-Id mcpd gave; useless without the profile's token. */
  sessionId: string;
  protocolVersion?: string;
  owner: Owner;
  name: string;
  createdAt: string;
  usedAt: string;
}

/** Where CLI sessions are saved: <state>/browser-do. */
export function sessionsDir(env: NodeJS.ProcessEnv): string {
  return join(paths(env).state, "browser-do");
}

export function sessionFile(env: NodeJS.ProcessEnv, identity: string, owner: number, name: string): string {
  return join(sessionsDir(env), `${identity}.${owner}.${name}.json`);
}

export function readSaved(file: string): SavedSession | undefined {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Partial<SavedSession>;
    if (s.v !== 1 || typeof s.sessionId !== "string" || typeof s.port !== "number" || !s.owner) return undefined;
    return s as SavedSession;
  } catch {
    return undefined;
  }
}

export function writeSaved(file: string, saved: SavedSession, env: NodeJS.ProcessEnv): void {
  writePrivateFile(file, `${JSON.stringify(saved, null, 2)}\n`, env);
}

export function dropSaved(file: string): void {
  rmSync(file, { force: true });
}

/** Removes the saved sessions whose owner exited (mcpd dropped those sessions already). */
export function sweepSaved(env: NodeJS.ProcessEnv, alive: (pid: number) => boolean = pidAlive): void {
  let names: string[];
  try {
    names = readdirSync(sessionsDir(env));
  } catch {
    return;
  }
  for (const n of names) {
    const m = /^[^.]+\.(\d+)\.[^.]+\.json$/.exec(n);
    if (m && !alive(Number(m[1]))) dropSaved(join(sessionsDir(env), n));
  }
}

/**
 * Runs `fn` while holding `<file>.lock`, so two commands of one session started at once open one
 * mcpd session, not two. A lock older than `staleMs` is from a command that died: taken over.
 */
export async function withLock<T>(file: string, env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const staleMs = 30_000;
  const until = Date.now() + 10_000;
  ensurePrivateDir(dirname(file), env);
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age > staleMs || Date.now() > until) {
        rmSync(lock, { force: true });
        continue;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * The mcp.toml server that serves identity `id`: a stdio server with `--identity <id>` in its
 * args (`browser-<id>` first, as `turno browser add` prints it).
 */
export function identityServer(manifest: Manifest, id: string): StdioServer | undefined {
  const serves = (args: readonly string[]) =>
    args.some((a, i) => (a === "--identity" && args[i + 1] === id) || a === `--identity=${id}`);
  const found = Object.values(manifest.servers).filter((s): s is StdioServer => s.kind === "stdio" && serves(s.args));
  return found.find((s) => s.name === `browser-${id}`) ?? found.sort((a, b) => a.name.localeCompare(b.name))[0];
}

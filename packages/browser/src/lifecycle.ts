import { execFileSync } from "node:child_process";
import { readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parseSingletonLock } from "./identities.js";

/**
 * The life of the Chrome behind one profile (ADR 0042).
 *
 * Playwright launches Chrome as the leader of its own process group and only kills that group
 * from exit handlers, which never run when the server is killed with SIGKILL. So
 * turno-browser-mcp
 *
 * - sweeps a Chrome that an earlier run left behind for the same profile before it starts
 *   (`sweepOrphan`): the profile's `SingletonLock` names the PID, the process table confirms it
 *   is a Chrome browser process for exactly that `--user-data-dir`, and its parent must be gone
 *   (reparented to init), so a Chrome another live process drives is never touched;
 * - puts a deadline on its own shutdown (`installShutdownGuard`): when stdin closes or a
 *   signal arrives the program closes the browser gracefully, and if that has not finished in
 *   time Chrome gets SIGTERM and then the whole group SIGKILL, inside the 4 seconds the MCP SDK
 *   gives a server before it kills it.
 */

interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

export type ProcTable = Map<number, ProcInfo>;

/** `ps -o pid=,ppid=,pgid=,command=` output. */
export function parseProcTable(stdout: string): ProcTable {
  const t: ProcTable = new Map();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    t.set(pid, { pid, ppid: Number(m[2]), pgid: Number(m[3]), command: m[4]! });
  }
  return t;
}

/** Every process with its full command line, or undefined when `ps` is not available. */
function readProcTable(): ProcTable | undefined {
  try {
    const out = execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH || "/bin:/usr/bin", LC_ALL: "C" },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 5000,
    });
    return parseProcTable(out);
  } catch {
    return undefined;
  }
}

/** The PID in the profile's `SingletonLock` (`<host>-<pid>`), if there is one. */
export function readLockPid(userDataDir: string): number | undefined {
  try {
    return parseSingletonLock(readlinkSync(join(userDataDir, "SingletonLock")));
  } catch {
    return undefined;
  }
}

/**
 * True when the command line passes exactly this profile as `--user-data-dir=<dir>` (the form
 * Playwright gives Chrome and its helpers; the wrapper's own `--user-data-dir <dir>` never
 * matches). Spaces in the path are fine; `<dir>-2` or `<dir>/sub` are other profiles.
 */
export function usesProfile(command: string, userDataDir: string): boolean {
  const dirs = new Set([userDataDir]);
  try {
    dirs.add(realpathSync(userDataDir));
  } catch {
    /* the profile is gone: only the given path can match */
  }
  for (const dir of dirs) {
    const flag = `--user-data-dir=${dir}`;
    for (let i = command.indexOf(flag); i >= 0; i = command.indexOf(flag, i + 1)) {
      const end = i + flag.length;
      if (end === command.length || command[end] === " ") return true;
    }
  }
  return false;
}

/** The browser process itself, not a renderer, GPU or utility helper (those carry `--type=`). */
export function isBrowserProcess(command: string): boolean {
  return !/(^|\s)--type=/.test(command);
}

/** Who drives the Chrome behind a profile: this process, nobody (an orphan), or someone else. */
type ChromeOwner = "self" | "orphan" | "other";

export interface ProfileChrome {
  /** The PID in the lock: the browser process, and the leader of its process group. */
  pid: number;
  pgid: number;
  /** False when only helpers are left in the group. */
  leaderAlive: boolean;
  owner: ChromeOwner;
}

type Alive = (pid: number) => boolean;
type Signal = (pid: number, signal: NodeJS.Signals) => void;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

/** A parent that means "nobody": init, launchd, a `systemd --user` subreaper, or none at all. */
function parentIsInit(ppid: number, table: ProcTable): boolean {
  const parent = table.get(ppid);
  return ppid <= 1 || !parent || /(^|\/)(launchd|systemd|init)(\s|$)/.test(parent.command);
}

export interface FindOptions {
  /** The process table to use (tests); read with `ps` when missing. */
  table?: ProcTable;
  readTable?: () => ProcTable | undefined;
  alive?: Alive;
  /** The PID that counts as "self" (default: this process). */
  selfPid?: number;
}

/**
 * The Chrome that holds this profile, after checking that the PID in the lock really is a
 * Chrome browser process for this exact profile dir. Undefined when there is none, or when the
 * lock points at some other program (a reused PID).
 */
export function findProfileChrome(userDataDir: string, opts: FindOptions = {}): ProfileChrome | undefined {
  const pid = readLockPid(userDataDir);
  if (pid === undefined) return undefined;
  const alive = opts.alive ?? processAlive;
  if (!opts.table && !alive(pid) && !alive(-pid)) return undefined;
  const table = opts.table ?? (opts.readTable ?? readProcTable)();
  if (!table) return undefined;
  const self = opts.selfPid ?? process.pid;
  const leader = table.get(pid);
  if (leader) {
    if (!usesProfile(leader.command, userDataDir) || !isBrowserProcess(leader.command)) return undefined;
    const owner: ChromeOwner = leader.ppid === self ? "self" : parentIsInit(leader.ppid, table) ? "orphan" : "other";
    return { pid, pgid: leader.pgid, leaderAlive: true, owner };
  }
  // The browser process died but helpers of its group may still run.
  const members = [...table.values()].filter((p) => p.pgid === pid && usesProfile(p.command, userDataDir));
  if (!members.length) return undefined;
  const orphaned = members.every((m) => parentIsInit(m.ppid, table) || table.get(m.ppid)?.pgid === pid);
  return { pid, pgid: pid, leaderAlive: false, owner: orphaned ? "orphan" : "other" };
}

export interface StopOptions {
  /** How long the browser gets to quit after SIGTERM. */
  graceMs?: number;
  /** How long to wait for the group to go after SIGKILL. */
  killMs?: number;
  signal?: Signal;
  alive?: Alive;
}

async function waitUntil(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/**
 * Gracefully, then forcefully: SIGTERM to the browser process alone (it shuts its helpers down
 * and writes the profile, cookies included; a SIGTERM to the whole group would kill the network
 * process that holds the cookie store at the same moment), then SIGKILL to the whole group.
 * A group is only signalled when the browser process leads it.
 */
export async function stopChrome(target: ProfileChrome, opts: StopOptions = {}): Promise<"exited" | "killed" | "survived"> {
  const signal = opts.signal ?? sendSignal;
  const alive = opts.alive ?? processAlive;
  const leadsGroup = target.pgid === target.pid;
  const handle = leadsGroup ? -target.pid : target.pid;
  const gone = () => !alive(handle);
  signal(target.leaderAlive ? target.pid : handle, "SIGTERM");
  if (await waitUntil(gone, opts.graceMs ?? 3000)) return "exited";
  signal(handle, "SIGKILL");
  return (await waitUntil(gone, opts.killMs ?? 2000)) ? "killed" : "survived";
}

export interface SweepResult {
  /** `none`: nothing holds the profile; `in-use`: a live process drives it, left alone. */
  action: "none" | "in-use" | "exited" | "killed" | "survived";
  pid?: number;
}

/** Stop a Chrome that an earlier run left behind on this profile (see the module comment). */
export async function sweepOrphan(userDataDir: string, opts: FindOptions & StopOptions = {}): Promise<SweepResult> {
  const found = findProfileChrome(userDataDir, opts);
  if (!found) return { action: "none" };
  if (found.owner !== "orphan") return { action: "in-use", pid: found.pid };
  return { action: await stopChrome(found, opts), pid: found.pid };
}

export interface ShutdownOptions {
  /** Time the program gets to close the browser gracefully before Chrome gets SIGTERM. */
  graceMs?: number;
  /** Time Chrome gets after SIGTERM before this process exits and its group gets SIGKILL. */
  termMs?: number;
}

/**
 * Bound the shutdown of this server. The program's own watchdog closes the browser when stdin
 * closes or on SIGINT and SIGTERM, but it allows itself 15 seconds, while the MCP SDK sends
 * SIGTERM 2 seconds after closing stdin and SIGKILL 2 seconds later. After `graceMs` the Chrome
 * this process started gets SIGTERM; after `termMs` more this process exits, and the exit
 * handler SIGKILLs the group if it is still there. SIGHUP is turned into SIGTERM so the
 * program closes the browser instead of the process dying with it open.
 */
export function installShutdownGuard(userDataDir: string, opts: ShutdownOptions = {}): void {
  const graceMs = opts.graceMs ?? 1500;
  const termMs = opts.termMs ?? 1000;
  const ours = () => {
    const c = findProfileChrome(userDataDir);
    return c && c.owner !== "other" ? c : undefined;
  };
  let started = false;
  const begin = () => {
    if (started) return;
    started = true;
    setTimeout(() => {
      const c = ours();
      if (c?.leaderAlive) sendSignal(c.pid, "SIGTERM");
      setTimeout(() => process.exit(0), termMs).unref();
    }, graceMs).unref();
  };
  process.stdin.once("close", begin);
  process.on("SIGTERM", begin);
  process.on("SIGINT", begin);
  process.on("SIGHUP", () => {
    begin();
    process.kill(process.pid, "SIGTERM");
  });
  process.on("exit", () => {
    const c = ours();
    if (c) sendSignal(c.pgid === c.pid ? -c.pid : c.pid, "SIGKILL");
  });
}

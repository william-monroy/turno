import { execFileSync } from "node:child_process";

/**
 * Process helpers shared by turno-cli and turno-browser: whether a PID lives, a signal that
 * never throws, and the process table with process groups (Chrome runs as the leader of its own
 * group).
 */

/** Whether a process is alive. EPERM means it exists but belongs to someone else. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Send a signal; a process that is already gone is not an error. A negative PID is a group. */
export function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

export interface ProcInfo {
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
export function readProcTable(): ProcTable | undefined {
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

/** A parent that means "nobody": init, launchd, a `systemd --user` subreaper, or none at all. */
export function parentIsInit(ppid: number, table: ProcTable): boolean {
  const parent = table.get(ppid);
  return ppid <= 1 || !parent || /(^|\/)(launchd|systemd|init)(\s|$)/.test(parent.command);
}

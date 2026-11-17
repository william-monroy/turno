import { readFileSync, realpathSync } from "node:fs";

/** Small file and process helpers shared across modules. Keep this file free of heavy imports. */

/** The real path of `p`, or `p` itself when it cannot be resolved (it does not exist, no access). */
export function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The parsed JSON of a file, or undefined when it is missing, unreadable or not JSON. */
export function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether a process is alive. EPERM means it exists but belongs to someone else. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

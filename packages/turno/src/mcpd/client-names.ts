import { atomicWrite } from "../core/journal.js";
import { PRIVATE_FILE_MODE } from "../core/paths.js";
import { isRecord, readState } from "../core/state-file.js";

/**
 * The client name (`clientInfo.name` from initialize) of each agent process, by PID, kept in a
 * small state file so a session mcpd rebuilds after a restart (ADR 0016) still has its agent's
 * name for the call log and `/status` (ADR 0026). Entries of processes that are gone are dropped
 * on the next write. Never holds anything but PIDs and printable names.
 */
export class ClientNames {
  private names = new Map<number, string>();

  constructor(
    private readonly file: string | undefined,
    private readonly isAlive: (pid: number) => boolean,
  ) {
    if (!file) return;
    // None yet, or unreadable: start empty.
    for (const [pid, name] of Object.entries(readState(file, isRecord) ?? {})) {
      const n = Number(pid);
      if (Number.isInteger(n) && n > 0 && typeof name === "string") this.names.set(n, name);
    }
  }

  get(pid: number | undefined): string | undefined {
    return pid ? this.names.get(pid) : undefined;
  }

  set(pid: number | undefined, name: string): void {
    if (!pid || this.names.get(pid) === name) return;
    this.names.set(pid, name);
    for (const p of this.names.keys()) if (!this.isAlive(p)) this.names.delete(p);
    if (!this.file) return;
    try {
      atomicWrite(this.file, `${JSON.stringify(Object.fromEntries(this.names))}\n`, PRIVATE_FILE_MODE);
    } catch {
      /* a disk that refuses the write only costs the name after a restart */
    }
  }
}

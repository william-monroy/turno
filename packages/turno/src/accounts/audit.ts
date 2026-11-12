import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../core/paths.js";

export type AuditOutcome = "ok" | "error" | "refused";

/** One line of ~/.local/state/turno/audit.jsonl: a call to the accounts bridge. */
export interface AuditEntry {
  ts: string;
  caller: { profile: string | null; pid: number | null };
  account: string;
  owner: string | null;
  write: boolean;
  /** First 500 characters of the task. */
  task: string;
  outcome: AuditOutcome;
  detail: string;
  durationMs: number;
  costUsd: number | null;
}

export const TASK_LIMIT = 500;

export type AuditInput = Omit<AuditEntry, "ts" | "task"> & { ts?: string; task: string };

/** Append one entry (file mode 600). Never throws: auditing must not break a delegation. */
export function appendAudit(entry: AuditInput, env: NodeJS.ProcessEnv = process.env): AuditEntry {
  const full: AuditEntry = {
    ts: entry.ts ?? new Date().toISOString(),
    caller: entry.caller,
    account: entry.account,
    owner: entry.owner,
    write: entry.write,
    task: entry.task.slice(0, TASK_LIMIT),
    outcome: entry.outcome,
    detail: entry.detail,
    durationMs: entry.durationMs,
    costUsd: entry.costUsd,
  };
  const file = paths(env).auditLog;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(full)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  return full;
}

/** The last `limit` entries, oldest first. Malformed lines are skipped. */
export function readAudit(limit = 20, env: NodeJS.ProcessEnv = process.env): AuditEntry[] {
  let text = "";
  try {
    text = readFileSync(paths(env).auditLog, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: AuditEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AuditEntry);
    } catch {
      /* skip */
    }
  }
  return limit > 0 ? out.slice(-limit) : out;
}

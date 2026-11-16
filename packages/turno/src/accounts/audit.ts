import { createHash } from "node:crypto";
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmdirSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { PRIVATE_FILE_MODE, ensurePrivateDir, paths } from "../core/paths.js";
import type { ConfirmPolicy } from "./policy.js";

export type AuditOutcome = "ok" | "error" | "refused" | "cancelled";

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
  /** The bridge's decision (ADR 0024), when the call reached one. */
  decision?: AuditDecision;
  /**
   * sha256 (hex) of the previous line as written, or GENESIS on the first line. Each line
   * commits to the one before, so editing or deleting a line breaks the chain (verifyAudit).
   */
  prev?: string;
}

/** What the bridge decided for a call, and what the run did with it. */
export interface AuditDecision {
  /** The confirmation policy in force. */
  policy: ConfirmPolicy;
  /** Whether the policy asked the user. */
  asked: boolean;
  /** The user's answer when asked: true only for an explicit confirmation. */
  confirmed?: boolean;
  /** `read`: the account's read tools only; `all`: every tool of the account. */
  toolset: "read" | "all";
  /** Tool patterns the run was allowed to call. */
  allowed: string[];
  /** `strict`: only the account's gateway servers; `profile`: the profile's MCP config. */
  mcp?: "strict" | "profile";
  /** Tools the run tried and Claude Code refused. */
  denied?: string[];
}

export const TASK_LIMIT = 500;

/** `prev` of the first chained line of an empty log. */
export const GENESIS = "0".repeat(64);

export type AuditInput = Omit<AuditEntry, "ts" | "task" | "prev"> & { ts?: string; task: string };

function lineHash(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}

/** The last non-empty line of an open file, read from its tail. */
function lastLine(fd: number): string | undefined {
  const size = fstatSync(fd).size;
  if (size === 0) return undefined;
  let chunk = 4096;
  for (;;) {
    const len = Math.min(chunk, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8").replace(/\n+$/, "");
    const nl = text.lastIndexOf("\n");
    if (nl >= 0 || len === size) return text.slice(nl + 1) || undefined;
    chunk *= 4;
  }
}

/** Sleep without a timer: appends are synchronous and rare. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Hold a lock folder next to the log while `fn` runs, so two writers do not chain to the same
 * line. A lock older than 10 s is stale (a crashed writer) and taken over.
 */
function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmdirSync(lock);
      } catch {
        /* someone else removed it */
      }
      if (Date.now() > deadline) break; // write anyway: verifyAudit will show the fork
      pause(10);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Append one entry: the file is opened append-only with mode 600, and the line carries the hash
 * of the line before it. Never throws: auditing must not break a delegation.
 */
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
    ...(entry.decision ? { decision: entry.decision } : {}),
  };
  const file = paths(env).auditLog;
  try {
    ensurePrivateDir(dirname(file), env);
    withLock(file, () => {
      // "a+": every write lands at the end (O_APPEND) and the tail can still be read.
      const fd = openSync(file, "a+", PRIVATE_FILE_MODE);
      try {
        if ((fstatSync(fd).mode & 0o777) !== PRIVATE_FILE_MODE) chmodSync(file, PRIVATE_FILE_MODE);
        const last = lastLine(fd);
        full.prev = last === undefined ? GENESIS : lineHash(last);
        writeSync(fd, `${JSON.stringify(full)}\n`);
      } finally {
        closeSync(fd);
      }
    });
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

export interface AuditVerification {
  ok: boolean;
  /** Lines checked (non-empty). */
  lines: number;
  /** Lines before the first chained one: written by a turno without the hash chain. */
  legacy: number;
  /** 1-based line number of the first problem. */
  line?: number;
  reason?: string;
}

/**
 * Check the hash chain of the audit log. It catches an edited, inserted, reordered or deleted
 * line, and lines removed from the start. It cannot catch lines cut from the end (nothing
 * commits to the last line), and anyone who can write the file can rebuild the chain: it shows
 * accidents and naive tampering, it is not a signature.
 */
export function verifyAudit(env: NodeJS.ProcessEnv = process.env): AuditVerification {
  let text = "";
  try {
    text = readFileSync(paths(env).auditLog, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, lines: 0, legacy: 0 };
    throw err;
  }
  const raw = text.split("\n");
  let lines = 0;
  let legacy = 0;
  let chained = false;
  let prevLine: string | undefined;
  for (const [i, line] of raw.entries()) {
    if (!line.trim()) continue;
    lines++;
    const fail = (reason: string): AuditVerification => ({ ok: false, lines, legacy, line: i + 1, reason });
    let entry: AuditEntry;
    try {
      entry = JSON.parse(line) as AuditEntry;
    } catch {
      return fail("not valid JSON");
    }
    if (entry.prev === undefined) {
      if (chained) return fail("line without a hash after the chain started (added by hand?)");
      legacy++;
    } else {
      const expected = prevLine === undefined ? GENESIS : lineHash(prevLine);
      if (entry.prev !== expected) return fail(prevLine === undefined ? "first line does not start the chain (lines removed from the start?)" : "hash does not match the previous line (edited, removed or reordered)");
      chained = true;
    }
    prevLine = line;
  }
  return { ok: true, lines, legacy };
}

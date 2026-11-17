import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { ClientContext } from "./instances.js";
import { ErrorCode, type Outcome } from "./jsonrpc.js";

/**
 * The call log (ADR 0026): one JSON line per tool call that mcpd relays, in
 * `<state>/logs/calls.jsonl`. A record says who called what and how it went. It never holds
 * the call's arguments or its result: only their sizes.
 */
export interface CallRecord {
  /** When the call arrived, UTC ISO. */
  time: string;
  /** The client's own name from initialize (claude-code, codex-mcp-client, ...), when known. */
  agent: string | null;
  profile: string | null;
  /** PID of the agent process, when known. */
  pid: number | null;
  server: string;
  variant: string | null;
  tool: string | null;
  durationMs: number;
  outcome: CallOutcome;
  /** Error text, redacted and cut to 300 characters; only when outcome is not ok. */
  error?: string;
  requestBytes: number;
  responseBytes: number;
}

type CallOutcome = "ok" | "error" | "cancelled" | "timeout";

/** What the instance manager reports after relaying one request (the hook in `forward`). */
export interface CallEvent {
  ctx: ClientContext;
  method: string;
  params: Record<string, unknown> | undefined;
  /** Undefined when no instance could be started. */
  variant?: string;
  outcome: Outcome;
  startedAt: number;
  durationMs: number;
}

/** Methods that get a record. */
const LOGGED = new Set(["tools/call"]);

const MAX_ERROR = 300;

/**
 * Hide what looks like a credential in an error text: bearer and basic values, key=value
 * pairs named like secrets, well-known token prefixes, and long opaque strings.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(/\b([A-Za-z_]*(?:token|secret|password|passwd|api[_-]?key|auth)[A-Za-z_]*)(["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi, "$1$2[redacted]")
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|xox[abpr]|glpat)[-_][A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/[A-Za-z0-9+_-]{32,}={0,2}/g, (s) => (/\d/.test(s) && /[A-Za-z]/.test(s) ? "[redacted]" : s));
}

function outcomeOf(o: Outcome): { outcome: CallOutcome; error?: string } {
  if ("error" in o) {
    const code = o.error.code;
    const outcome: CallOutcome = code === ErrorCode.RequestCancelled ? "cancelled" : code === ErrorCode.RequestTimeout ? "timeout" : "error";
    return { outcome, error: redact(String(o.error.message ?? "")).slice(0, MAX_ERROR) };
  }
  // A tool that failed answers with a result marked isError; its text is a result, so it stays out.
  if (o.result.isError === true) return { outcome: "error", error: "the tool reported an error" };
  return { outcome: "ok" };
}

function bytes(v: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(v ?? {}));
  } catch {
    return 0;
  }
}

/** A printable client name, at most 64 characters. */
export function cleanAgentName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const clean = name.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 64);
  return clean || undefined;
}

/** The record for one relayed request, or undefined when the method is not logged. */
export function toRecord(e: CallEvent): CallRecord | undefined {
  if (!LOGGED.has(e.method)) return undefined;
  const tool = typeof e.params?.name === "string" ? e.params.name.slice(0, 200) : null;
  const { outcome, error } = outcomeOf(e.outcome);
  return {
    time: new Date(e.startedAt).toISOString(),
    agent: e.ctx.clientName ?? null,
    profile: e.ctx.profile ?? null,
    pid: e.ctx.pid ?? null,
    server: e.ctx.serverName,
    variant: e.variant ?? null,
    tool,
    durationMs: Math.max(0, Math.round(e.durationMs)),
    outcome,
    ...(error !== undefined ? { error } : {}),
    requestBytes: bytes(e.params),
    responseBytes: bytes("error" in e.outcome ? e.outcome.error : e.outcome.result),
  };
}

export interface CallLog {
  /** Record one relayed request (ignored when the method is not logged). Never throws. */
  record(e: CallEvent): void;
  close(): void;
}

/**
 * Append-only writer, synchronous like mcpd.log so records keep their order across a
 * rotation: `calls.jsonl` becomes `calls.jsonl.1` at `maxBytes` and `keep` old files are kept.
 * Mode 600. A disk that refuses writes never takes mcpd down.
 */
export function createCallLog(file: string, opts: { maxBytes?: number; keep?: number; onError?: (message: string) => void } = {}): CallLog {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const keep = opts.keep ?? 2;
  let fd: number | undefined;
  let size = 0;
  let reported = false;
  const fail = (err: unknown) => {
    if (reported) return;
    reported = true;
    opts.onError?.(`cannot write ${file}: ${(err as Error).message}`);
  };
  const close = () => {
    if (fd === undefined) return;
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    fd = undefined;
  };
  const open = () => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    fd = openSync(file, "a", 0o600);
    size = fstatSync(fd).size;
  };
  const rotate = () => {
    close();
    for (let i = keep - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    renameSync(file, `${file}.1`);
  };
  return {
    record(e) {
      try {
        const r = toRecord(e);
        if (!r) return;
        const line = Buffer.from(`${JSON.stringify(r)}\n`);
        if (fd === undefined) open();
        if (size > 0 && size + line.length > maxBytes) {
          rotate();
          open();
        }
        writeSync(fd as number, line);
        size += line.length;
        reported = false;
      } catch (err) {
        close();
        fail(err);
      }
    },
    close,
  };
}

// Reading ---------------------------------------------------------------------------------------

export interface CallFilter {
  server?: string;
  profile?: string;
}

function parseLine(line: string): CallRecord | undefined {
  if (!line.trim()) return undefined;
  try {
    const r = JSON.parse(line) as CallRecord;
    return r && typeof r === "object" && typeof r.server === "string" && typeof r.time === "string" ? r : undefined;
  } catch {
    return undefined;
  }
}

function matches(r: CallRecord, f: CallFilter): boolean {
  return (f.server === undefined || r.server === f.server) && (f.profile === undefined || r.profile === f.profile);
}

function readText(file: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The last `tail` records that match, oldest first. Reads the current file, then the rotated
 * ones only while more records are needed. Lines that do not parse are skipped.
 */
export function readCalls(file: string, tail: number, filter: CallFilter = {}, keep = 2): CallRecord[] {
  const out: CallRecord[] = [];
  for (let i = 0; i <= keep && out.length < tail; i++) {
    const f = i === 0 ? file : `${file}.${i}`;
    if (!existsSync(f)) continue;
    const found = readText(f)
      .split("\n")
      .map(parseLine)
      .filter((r): r is CallRecord => r !== undefined && matches(r, filter));
    out.unshift(...found.slice(-(tail - out.length)));
  }
  return out;
}

/**
 * Follow the file like `tail -f`: report each new matching record until `signal` aborts.
 * Polls (every `everyMs`), so it works on every platform and survives a rotation: a file that
 * got smaller or was replaced is read again from its start.
 */
export async function followCalls(
  file: string,
  onRecord: (r: CallRecord) => void,
  signal: AbortSignal,
  filter: CallFilter = {},
  everyMs = 500,
): Promise<void> {
  let offset = 0;
  let ino: number | undefined;
  try {
    const st = statSync(file);
    offset = st.size;
    ino = st.ino;
  } catch {
    /* not there yet */
  }
  let partial = "";
  const poll = () => {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(file);
    } catch {
      return;
    }
    if (st.ino !== ino || st.size < offset) {
      ino = st.ino;
      offset = 0;
      partial = "";
    }
    if (st.size === offset) return;
    let fd: number | undefined;
    try {
      fd = openSync(file, "r");
      const len = Number(st.size) - offset;
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, offset);
      offset += n;
      const text = partial + buf.subarray(0, n).toString("utf8");
      const lines = text.split("\n");
      partial = lines.pop() ?? "";
      for (const l of lines) {
        const r = parseLine(l);
        if (r && matches(r, filter)) onRecord(r);
      }
    } catch {
      /* try again on the next tick */
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setInterval(poll, everyMs);
    signal.addEventListener(
      "abort",
      () => {
        clearInterval(timer);
        poll();
        resolve();
      },
      { once: true },
    );
  });
}

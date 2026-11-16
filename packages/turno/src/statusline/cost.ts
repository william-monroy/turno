import { existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";

type Price = [number, number, number, number, number];

/**
 * $/MTok: input, output, cache write 5 m, cache write 1 h, cache read, for Anthropic first-party
 * API rates (Bedrock and Vertex ids map to the same model; their regional prices can differ a
 * little). Ids are matched after `normalizeModel()`, exactly: an unknown id has no price, so the
 * status line can say "$?" instead of a silent $0.00. Retired models stay so old transcripts
 * keep their cost.
 */
export const PRICES: Record<string, Price> = {
  "claude-fable-5-2": [8, 40, 10, 16, 0.2],
  "claude-mythos-5-2": [8, 40, 10, 16, 0.2],
  "claude-fable-5-1": [10, 50, 12.5, 20, 0.25],
  "claude-mythos-5-1": [10, 50, 12.5, 20, 0.25],
  "claude-fable-5": [10, 50, 12.5, 20, 1.0],
  "claude-mythos-5": [10, 50, 12.5, 20, 1.0],
  "claude-opus-5-5": [4, 20, 5, 8, 0.2],
  "claude-opus-5": [5, 25, 6.25, 10, 0.5],
  "claude-opus-4-8": [5, 25, 6.25, 10, 0.5],
  "claude-opus-4-7": [5, 25, 6.25, 10, 0.5],
  "claude-opus-4-6": [5, 25, 6.25, 10, 0.5],
  "claude-opus-4-5": [5, 25, 6.25, 10, 0.5],
  "claude-opus-4-1": [15, 75, 18.75, 30, 1.5],
  "claude-opus-4": [15, 75, 18.75, 30, 1.5],
  "claude-3-opus": [15, 75, 18.75, 30, 1.5],
  "claude-sonnet-5-5": [2, 10, 2.5, 4, 0.1],
  "claude-sonnet-5": [2, 10, 2.5, 4, 0.2],
  "claude-sonnet-4-6": [3, 15, 3.75, 6, 0.3],
  "claude-sonnet-4-5": [3, 15, 3.75, 6, 0.3],
  "claude-sonnet-4": [3, 15, 3.75, 6, 0.3],
  "claude-3-7-sonnet": [3, 15, 3.75, 6, 0.3],
  "claude-3-5-sonnet": [3, 15, 3.75, 6, 0.3],
  "claude-haiku-5-5": [0.1, 0.5, 0.125, 0.2, 0.01],
  "claude-haiku-4-5": [1, 5, 1.25, 2, 0.1],
  "claude-3-5-haiku": [0.8, 4, 1, 1.6, 0.08],
  "claude-3-haiku": [0.25, 1.25, 0.3, 0.5, 0.03],
};

/** Models whose price rises once the prompt passes a size: above `over` tokens, `price` applies. */
const LONG_PROMPT: Record<string, { over: number; price: Price }> = {
  "claude-haiku-5-5": { over: 100_000, price: [0.5, 2.5, 0.625, 1, 0.05] },
};

/**
 * The first-party id of a model as it appears in a transcript: drops the Bedrock prefixes
 * (`us.anthropic.`, ARNs), the Vertex `@date` suffix, Bedrock `-v1:0` suffixes, `[1m]`
 * markers and `-YYYYMMDD` snapshot dates.
 */
export function normalizeModel(model: string): string {
  let m = model.trim().toLowerCase();
  const at = m.lastIndexOf("claude-");
  if (at > 0) m = m.slice(at);
  return m
    .replace(/\[[^\]]*\]$/, "")
    .replace(/@.*$/, "")
    .replace(/-v\d+(:\d+)?$/, "")
    .replace(/-\d{8}$/, "");
}

export function priceFor(model: string | undefined): Price | undefined {
  if (typeof model !== "string" || !model) return undefined;
  return PRICES[normalizeModel(model)];
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
  speed?: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Tokens a usage record bills: zero for Claude Code's synthetic messages. */
export function usageTokens(u: Usage): number {
  return num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
}

/**
 * API cost in USD of one assistant usage record, or undefined when the model has no price.
 * A record without tokens costs 0 whatever its model.
 */
export function usageCost(model: string | undefined, u: Usage): number | undefined {
  if (usageTokens(u) === 0) return 0;
  let p = priceFor(model);
  if (!p) return undefined;
  const long = LONG_PROMPT[normalizeModel(model!)];
  if (long && num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens) > long.over) p = long.price;
  const w1h = num(u.cache_creation?.ephemeral_1h_input_tokens);
  const w5m =
    u.cache_creation?.ephemeral_5m_input_tokens !== undefined
      ? num(u.cache_creation.ephemeral_5m_input_tokens)
      : Math.max(0, num(u.cache_creation_input_tokens) - w1h);
  const usd = (num(u.input_tokens) * p[0] + num(u.output_tokens) * p[1] + w5m * p[2] + w1h * p[3] + num(u.cache_read_input_tokens) * p[4]) / 1e6;
  return usd * (u.speed === "fast" ? 2 : 1);
}

interface FileState {
  offset: number;
  usd: number;
  recent: string[];
  /** Models seen with tokens but no price: their cost is missing from `usd`. */
  unknown?: string[];
}

/** Bumped when an older state would give a wrong total (v2: unknown models are tracked). */
const STATE_VERSION = 2;

export interface CostState {
  v: number;
  files: Record<string, FileState>;
  main: number;
  sub: number;
  total: number;
  /** Models without a price in any transcript of the conversation: the total is too low. */
  unknown: string[];
  updated_at: number;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function validState(v: unknown): v is CostState {
  if (!v || typeof v !== "object") return false;
  const o = v as Partial<CostState>;
  return o.v === STATE_VERSION && !!o.files && typeof o.files === "object" && !Array.isArray(o.files);
}

function validFile(v: unknown): v is FileState {
  if (!v || typeof v !== "object") return false;
  const f = v as Partial<FileState>;
  return typeof f.offset === "number" && typeof f.usd === "number" && Array.isArray(f.recent);
}

/** Read only complete new lines of a transcript and add their cost. */
function scan(path: string, st: FileState): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size < st.offset) Object.assign(st, { offset: 0, usd: 0, recent: [], unknown: [] });
  if (size === st.offset) return;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - st.offset);
    readSync(fd, buf, 0, buf.length, st.offset);
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(10, start);
      if (nl < 0) break; // partial line: read it next time
      const line = buf.subarray(start, nl);
      st.offset += nl + 1 - start;
      start = nl + 1;
      if (line.indexOf('"usage"') < 0) continue;
      let o: { type?: string; requestId?: string; message?: { id?: string; model?: string; usage?: Usage } };
      try {
        o = JSON.parse(line.toString("utf8"));
      } catch {
        continue;
      }
      const m = o?.message;
      if (o?.type !== "assistant" || !m?.usage || typeof m.usage !== "object") continue;
      const key = `${m.id}|${o.requestId}`; // every block of one response repeats its usage
      if (st.recent.includes(key)) continue;
      st.recent.push(key);
      if (st.recent.length > 64) st.recent.splice(0, st.recent.length - 64);
      const usd = usageCost(m.model, m.usage);
      if (usd !== undefined) st.usd += usd;
      else {
        const id = typeof m.model === "string" && m.model ? m.model.slice(0, 120) : "(none)";
        st.unknown ??= [];
        if (!st.unknown.includes(id)) st.unknown.push(id);
      }
    }
  } finally {
    closeSync(fd);
  }
}

/** Incremental cost of a conversation: the main transcript plus its subagents. */
export function computeCost(transcript: string, out: string, now = Date.now() / 1000): CostState {
  const prev = readJson<unknown>(out);
  const files: Record<string, FileState> = {};
  if (validState(prev)) for (const [k, f] of Object.entries(prev.files)) if (validFile(f)) files[k] = f;
  const main = real(transcript);
  const stem = main.endsWith(".jsonl") ? main.slice(0, -6) : main;
  const subDir = join(stem, "subagents");
  const subs = existsSync(subDir)
    ? readdirSync(subDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => real(join(subDir, f)))
        .sort()
    : [];
  for (const p of [main, ...subs]) {
    files[p] ??= { offset: 0, usd: 0, recent: [], unknown: [] };
    scan(p, files[p]!);
  }
  const mainUsd = files[main]?.usd ?? 0;
  const total = Object.values(files).reduce((a, f) => a + f.usd, 0);
  const unknown = [...new Set(Object.values(files).flatMap((f) => f.unknown ?? []))];
  const state: CostState = { v: STATE_VERSION, files, main: mainUsd, sub: total - mainUsd, total, unknown, updated_at: now };
  try {
    writeJson(out, state);
  } finally {
    rmSync(`${out}.lock`, { force: true });
  }
  return state;
}

/** Remove status line cache files not touched for `maxAgeDays`, at most once a day. */
export function pruneCache(dir: string, now = Date.now() / 1000, maxAgeDays = 7): number {
  const stamp = join(dir, ".pruned");
  try {
    if (now - statSync(stamp).mtimeMs / 1000 < 86_400) return 0;
  } catch {
    /* never pruned */
  }
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (name === ".pruned") continue;
    const file = join(dir, name);
    try {
      const st = statSync(file);
      if (st.isFile() && now - st.mtimeMs / 1000 > maxAgeDays * 86_400) {
        rmSync(file, { force: true });
        removed++;
      }
    } catch {
      /* raced with another worker */
    }
  }
  try {
    writeFileSync(stamp, "");
  } catch {
    /* read-only: try again next time */
  }
  return removed;
}

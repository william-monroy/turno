import { existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";

/** $/MTok: input, output, cache write 5 m, cache write 1 h, cache read. Longest prefix wins. */
export const PRICES: Record<string, [number, number, number, number, number]> = {
  "claude-fable-5-2": [10, 50, 12.5, 20, 0.25],
  "claude-fable-5-1": [10, 50, 12.5, 20, 0.25],
  "claude-mythos-5-1": [10, 50, 12.5, 20, 0.25],
  "claude-fable-5": [10, 50, 12.5, 20, 1.0],
  "claude-opus-5-5": [4, 20, 5, 8, 0.2],
  "claude-opus-5": [5, 25, 6.25, 10, 0.5],
  "claude-opus-4-8": [5, 25, 6.25, 10, 0.5],
  "claude-opus-4-7": [5, 25, 6.25, 10, 0.5],
  "claude-opus-4-6": [5, 25, 6.25, 10, 0.5],
  "claude-sonnet-5-5": [2, 10, 2.5, 4, 0.2],
  "claude-sonnet-5": [2, 10, 2.5, 4, 0.2],
  "claude-sonnet-4-6": [3, 15, 3.75, 6, 0.3],
  "claude-haiku-5-5": [1, 5, 1.25, 2, 0.1],
  "claude-haiku-4-5": [1, 5, 1.25, 2, 0.1],
};

const KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

export function priceFor(model: string | undefined): [number, number, number, number, number] | undefined {
  if (!model) return undefined;
  for (const k of KEYS) if (model.startsWith(k)) return PRICES[k];
  return undefined;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
  speed?: string;
}

/** API cost in USD of one assistant usage record. */
export function usageCost(model: string | undefined, u: Usage): number {
  const p = priceFor(model);
  if (!p) return 0;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1h);
  const usd =
    ((u.input_tokens ?? 0) * p[0] + (u.output_tokens ?? 0) * p[1] + w5m * p[2] + w1h * p[3] + (u.cache_read_input_tokens ?? 0) * p[4]) / 1e6;
  return usd * (u.speed === "fast" ? 2 : 1);
}

interface FileState {
  offset: number;
  usd: number;
  recent: string[];
}

export interface CostState {
  files: Record<string, FileState>;
  main: number;
  sub: number;
  total: number;
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

/** Read only complete new lines of a transcript and add their cost. */
function scan(path: string, st: FileState): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size < st.offset) Object.assign(st, { offset: 0, usd: 0, recent: [] });
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
      const m = o.message;
      if (o.type !== "assistant" || !m?.usage) continue;
      const key = `${m.id}|${o.requestId}`; // every block of one response repeats its usage
      if (st.recent.includes(key)) continue;
      st.recent.push(key);
      if (st.recent.length > 64) st.recent.splice(0, st.recent.length - 64);
      st.usd += usageCost(m.model, m.usage);
    }
  } finally {
    closeSync(fd);
  }
}

/** Incremental cost of a conversation: the main transcript plus its subagents. */
export function computeCost(transcript: string, out: string, now = Date.now() / 1000): CostState {
  const prev = readJson<CostState>(out);
  const files = prev?.files ?? {};
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
    files[p] ??= { offset: 0, usd: 0, recent: [] };
    scan(p, files[p]!);
  }
  const mainUsd = files[main]?.usd ?? 0;
  const total = Object.values(files).reduce((a, f) => a + f.usd, 0);
  const state: CostState = { files, main: mainUsd, sub: total - mainUsd, total, updated_at: now };
  writeJson(out, state);
  rmSync(`${out}.lock`, { force: true });
  return state;
}

import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { atomicWrite } from "../core/journal.js";

const run = promisify(execFile);

/** Parent and resident memory (bytes) of every process we can see, by PID. */
export type ProcTable = Map<number, { ppid: number; rss: number }>;

export interface ProcTableOptions {
  /** PATH used to find `ps` (tests point it at a fake one, or at nothing). */
  env?: NodeJS.ProcessEnv;
  /** Where procfs lives (Linux), used when `ps` is missing or fails. Default /proc. */
  procRoot?: string;
}

/** `ps -A -o pid=,ppid=,rss=` output (rss in KiB, as both macOS and procps print it). */
export function parsePs(stdout: string): ProcTable {
  const t: ProcTable = new Map();
  for (const line of stdout.split("\n")) {
    const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && (pid as number) > 0 && Number.isInteger(ppid) && Number.isFinite(rss)) {
      t.set(pid as number, { ppid: ppid as number, rss: (rss as number) * 1024 });
    }
  }
  return t;
}

/** The same table from /proc/<pid>/status (PPid and VmRSS lines). Undefined without procfs. */
export function procfsTable(root = "/proc"): ProcTable | undefined {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  const t: ProcTable = new Map();
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const text = readFileSync(join(root, e, "status"), "utf8");
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(text)?.[1]);
      const kb = /^VmRSS:\s+(\d+)\s*kB/m.exec(text)?.[1];
      if (Number.isInteger(ppid)) t.set(Number(e), { ppid, rss: kb ? Number(kb) * 1024 : 0 });
    } catch {
      /* the process exited while we looked */
    }
  }
  return t.size ? t : undefined;
}

/**
 * Every process with its parent and RSS: `ps` (macOS and Linux), else procfs on Linux.
 * Undefined when neither is available, so callers can say memory is unknown instead of 0.
 */
export async function processTable(opts: ProcTableOptions = {}): Promise<ProcTable | undefined> {
  try {
    const env = opts.env ?? process.env;
    const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,rss="], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
      env: { PATH: env.PATH ?? "", LC_ALL: "C" },
    });
    const t = parsePs(stdout);
    if (t.size) return t;
  } catch {
    /* no ps (minimal containers): try procfs */
  }
  return procfsTable(opts.procRoot);
}

/** RSS of a process and all its descendants (npx and shell wrappers start the real server as a child). */
export function treeRss(table: ProcTable, pid: number): number | undefined {
  if (!table.has(pid)) return undefined;
  const children = new Map<number, number[]>();
  for (const [p, { ppid }] of table) {
    if (p === ppid) continue;
    const list = children.get(ppid);
    if (list) list.push(p);
    else children.set(ppid, [p]);
  }
  let total = 0;
  const seen = new Set<number>();
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop() as number;
    if (seen.has(p)) continue;
    seen.add(p);
    total += table.get(p)?.rss ?? 0;
    stack.push(...(children.get(p) ?? []));
  }
  return total;
}

/** Last measured RSS of a server variant (`name@variant`). */
export interface RssSample {
  bytes: number;
  at: string;
}

/**
 * What each server variant used the last time it ran, so `turno mcp savings` can estimate
 * servers that are not running now. mcpd samples its instances every 15 seconds while any
 * runs and keeps the result in `state/mcpd-rss.json` (mode 600) across restarts.
 */
export class RssSampler {
  private known: Record<string, RssSample> = {};
  private busy = false;

  constructor(
    private readonly file: string,
    private readonly opts: ProcTableOptions = {},
  ) {
    try {
      const v = JSON.parse(readFileSync(file, "utf8")) as Record<string, RssSample>;
      for (const [k, s] of Object.entries(v ?? {})) if (typeof s?.bytes === "number" && typeof s.at === "string") this.known[k] = s;
    } catch {
      /* first run */
    }
  }

  samples(): Record<string, RssSample> {
    return { ...this.known };
  }

  /** Measure the running instances (descKey and PID) and remember each variant's RSS. */
  async sample(instances: { descKey: string; pid: number | undefined }[], now = new Date()): Promise<void> {
    const live = instances.filter((i): i is { descKey: string; pid: number } => typeof i.pid === "number" && i.pid > 0);
    if (!live.length || this.busy) return;
    this.busy = true;
    try {
      const table = await processTable(this.opts);
      if (!table) return;
      const sums = new Map<string, number[]>();
      for (const i of live) {
        const rss = treeRss(table, i.pid);
        if (rss) sums.set(i.descKey, [...(sums.get(i.descKey) ?? []), rss]);
      }
      if (!sums.size) return;
      for (const [k, list] of sums) this.known[k] = { bytes: Math.round(list.reduce((a, b) => a + b, 0) / list.length), at: now.toISOString() };
      try {
        atomicWrite(this.file, `${JSON.stringify(this.known)}\n`, 0o600);
      } catch {
        /* the memory copy still serves /status */
      }
    } finally {
      this.busy = false;
    }
  }
}

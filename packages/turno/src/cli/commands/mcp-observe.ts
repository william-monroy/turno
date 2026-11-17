import type { CallRecord } from "../../mcpd/calllog.js";
import type { ProcTable } from "../../mcpd/rss.js";
import { type FlagSpec, JSON_FLAG, TAIL, bool, count, parseFlags, printJson, str } from "../args.js";
import { type Io, paint } from "../io.js";

/**
 * Observability subcommands of `turno mcp` (ADR 0026): `log` reads the call log mcpd keeps,
 * `top` shows what each running server costs, `savings` compares mcpd's memory with what the
 * same agent sessions would use without the gateway.
 */

export const LOG_FLAGS: FlagSpec = { follow: { type: "boolean", short: "f" }, ...TAIL, server: { type: "string" }, profile: { type: "string" }, ...JSON_FLAG };
export const TOP_FLAGS: FlagSpec = { once: { type: "boolean" }, ...JSON_FLAG };
export const SAVINGS_FLAGS: FlagSpec = { ...JSON_FLAG };

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** "95 MB", "1.4 GB"; "?" when unknown. */
export function memory(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "?";
  return bytes >= GiB ? `${(bytes / GiB).toFixed(1)} GB` : `${Math.round(bytes / MiB)} MB`;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MiB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MiB).toFixed(1)} MB`;
}

/** 42s, 3m 5s, 2h 4m, 3d 1h. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** Rows padded to the widest cell of each column (the last column is not padded). */
function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd());
}

/** Abort on Ctrl-C, for the commands that keep running. */
function untilInterrupted(): { signal: AbortSignal; dispose(): void } {
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once("SIGINT", stop);
  return { signal: ac.signal, dispose: () => process.off("SIGINT", stop) };
}

// log ----------------------------------------------------------------------------------------

const OUTCOME_COLOR: Record<string, string> = { ok: "32", error: "31", timeout: "33", cancelled: "2" };

/** One call as a line: local time, outcome, duration, server, tool, profile, agent, sizes, error. */
export function formatCall(io: Io, r: CallRecord, localTime: (iso: string) => string): string {
  const server = r.variant && r.variant !== "default" ? `${r.server}@${r.variant}` : r.server;
  const cells = [
    localTime(r.time),
    paint(io, r.outcome.padEnd(9), OUTCOME_COLOR[r.outcome] ?? "0"),
    `${r.durationMs} ms`.padStart(9),
    server.padEnd(18),
    (r.tool ?? "-").padEnd(22),
    (r.profile ?? "-").padEnd(10),
    (r.agent ?? "-").padEnd(16),
    `${size(r.requestBytes)} in, ${size(r.responseBytes)} out`,
  ];
  return `${cells.join(" ")}${r.error ? `  ${r.error}` : ""}`;
}

/** `turno mcp log`; `signal` stops `--follow` (Ctrl-C when not given). */
export async function log(args: string[], io: Io, signal?: AbortSignal): Promise<number> {
  const p = parseFlags(args, LOG_FLAGS, 0);
  const n = count(p, "tail", 20);
  const filter = { ...(str(p, "server") ? { server: str(p, "server") } : {}), ...(str(p, "profile") ? { profile: str(p, "profile") } : {}) };
  const json = bool(p, "json");
  const { daemonFiles, loadConfigSafe } = await import("../../mcpd/daemon.js");
  const { followCalls, readCalls } = await import("../../mcpd/calllog.js");
  const { localTime } = await import("./mcpd.js");
  const file = daemonFiles(io.env).calls;
  if (!loadConfigSafe(io.env).config.mcpd.callLog) {
    io.err(`${paint(io, "note", "33")}: the call log is off (call_log = false under [mcpd] in config.toml); mcpd records no new calls`);
  }
  const print = (r: CallRecord) => io.out(json ? JSON.stringify(r) : formatCall(io, r, localTime));
  const records = readCalls(file, n, filter);
  if (!records.length && !json && !bool(p, "follow")) {
    io.out("no tool calls logged yet (mcpd adds one line per tool call it relays)");
    return 0;
  }
  for (const r of records) print(r);
  if (!bool(p, "follow")) return 0;
  const stop = signal ? { signal, dispose() {} } : untilInterrupted();
  try {
    await followCalls(file, print, stop.signal, filter);
  } finally {
    stop.dispose();
  }
  return 0;
}

// status helpers ------------------------------------------------------------------------------

interface StatusInstance {
  key: string;
  server: string;
  variant: string;
  scope: string;
  pid: number | null;
  clients: number;
  inflight: number;
  idleSeconds: number;
  startedAt: number;
  restarts?: number;
  holder: { profile: string | null; pid: number | null } | null;
}

interface StatusAgent {
  pid: number | null;
  profile: string | null;
  agent: string | null;
  servers: string[];
}

interface Status {
  pid: number;
  version?: string;
  startedAt?: string;
  sessions: number;
  agents?: StatusAgent[];
  instances: StatusInstance[];
  serverRss?: Record<string, { bytes: number; at: string }>;
}

/** /status of the running mcpd, or undefined when it does not answer. */
async function fetchStatus(env: NodeJS.ProcessEnv): Promise<Status | undefined> {
  const { mcpdRequest } = await import("./mcp.js");
  const r = await mcpdRequest(env, "GET", "/status");
  if (r === "down" || r.status !== 200 || typeof r.body !== "object" || r.body === null) return undefined;
  const s = r.body as Status;
  return { ...s, instances: Array.isArray(s.instances) ? s.instances : [] };
}

async function measure(env: NodeJS.ProcessEnv): Promise<ProcTable | undefined> {
  const { processTable } = await import("../../mcpd/rss.js");
  return processTable({ env });
}

function notRunning(io: Io, json: boolean): number {
  if (json) printJson(io, { running: false });
  else io.out("mcpd is not running (turno mcp daemon start)");
  return 1;
}

const MEMORY_UNKNOWN = "memory is unknown: ps is not available and there is no /proc";

// top ----------------------------------------------------------------------------------------

export interface TopSnapshot {
  running: true;
  mcpd: { pid: number; version: string | null; uptimeSeconds: number | null; sessions: number; agents: number; rssBytes: number | null; totalRssBytes: number | null };
  instances: {
    server: string;
    variant: string;
    scope: string;
    pid: number | null;
    rssBytes: number | null;
    sessions: number;
    inflight: number;
    idleSeconds: number;
    restarts: number;
    uptimeSeconds: number;
    heldBy: { profile: string | null; pid: number | null } | null;
  }[];
  memoryKnown: boolean;
}

export async function topSnapshot(status: Status, procs: ProcTable | undefined, now = Date.now()): Promise<TopSnapshot> {
  const { treeRss } = await import("../../mcpd/rss.js");
  const started = status.startedAt ? Date.parse(status.startedAt) : Number.NaN;
  return {
    running: true,
    mcpd: {
      pid: status.pid,
      version: status.version ?? null,
      uptimeSeconds: Number.isFinite(started) ? Math.round((now - started) / 1000) : null,
      sessions: status.sessions,
      agents: status.agents?.length ?? 0,
      rssBytes: procs?.get(status.pid)?.rss ?? null,
      totalRssBytes: procs ? (treeRss(procs, status.pid) ?? null) : null,
    },
    instances: status.instances
      .map((i) => ({
        server: i.server,
        variant: i.variant,
        scope: i.scope,
        pid: i.pid,
        rssBytes: procs && i.pid ? (treeRss(procs, i.pid) ?? null) : null,
        sessions: i.clients,
        inflight: i.inflight,
        idleSeconds: i.idleSeconds,
        restarts: i.restarts ?? 0,
        uptimeSeconds: Math.round((now - i.startedAt) / 1000),
        heldBy: i.holder,
      }))
      .sort((a, b) => (b.rssBytes ?? 0) - (a.rssBytes ?? 0) || a.server.localeCompare(b.server)),
    memoryKnown: procs !== undefined,
  };
}

export function renderTop(io: Io, t: TopSnapshot): string[] {
  const m = t.mcpd;
  const head = [
    `mcpd pid ${m.pid}`,
    m.version ? `v${m.version}` : "",
    m.uptimeSeconds !== null ? `up ${duration(m.uptimeSeconds)}` : "",
    `${memory(m.rssBytes)} own, ${memory(m.totalRssBytes)} with servers`,
    `${m.sessions} session${m.sessions === 1 ? "" : "s"} from ${m.agents} agent${m.agents === 1 ? "" : "s"}`,
  ].filter(Boolean);
  const out = [paint(io, head.join(" · "), "1")];
  if (!t.memoryKnown) out.push(`  ${paint(io, "note", "33")}: ${MEMORY_UNKNOWN}`);
  if (!t.instances.length) {
    out.push("  no servers running (they start on first use)");
    return out;
  }
  const rows = [["SERVER", "VARIANT", "SCOPE", "PID", "RSS", "SESSIONS", "IN FLIGHT", "IDLE", "RESTARTS", "UP", "HELD BY"]];
  for (const i of t.instances) {
    rows.push([
      i.server,
      i.variant,
      i.scope,
      i.pid ? String(i.pid) : "-",
      i.pid ? memory(i.rssBytes) : "in mcpd",
      String(i.sessions),
      String(i.inflight),
      duration(i.idleSeconds),
      String(i.restarts),
      duration(i.uptimeSeconds),
      i.heldBy ? `${i.heldBy.profile ?? "?"}/${i.heldBy.pid ?? "?"}` : "",
    ]);
  }
  const lines = table(rows);
  out.push(paint(io, lines[0]!, "2"), ...lines.slice(1));
  return out;
}

/** `turno mcp top`: refreshes every 2 s in a terminal until Ctrl-C; one snapshot otherwise. */
export async function top(args: string[], io: Io, signal?: AbortSignal, everyMs = 2000): Promise<number> {
  const p = parseFlags(args, TOP_FLAGS, 0);
  const json = bool(p, "json");
  const once = json || bool(p, "once") || !io.isTty;
  const snap = async (): Promise<TopSnapshot | undefined> => {
    const s = await fetchStatus(io.env);
    return s ? topSnapshot(s, await measure(io.env)) : undefined;
  };
  if (once) {
    const t = await snap();
    if (!t) return notRunning(io, json);
    if (json) printJson(io, t);
    else for (const l of renderTop(io, t)) io.out(l);
    return 0;
  }
  const stop = signal ? { signal, dispose() {} } : untilInterrupted();
  try {
    while (!stop.signal.aborted) {
      const t = await snap();
      const lines = t ? renderTop(io, t) : ["mcpd is not running (turno mcp daemon start); trying again"];
      io.out(`\x1b[H\x1b[2J${lines.join("\n")}\n${paint(io, `every ${everyMs / 1000}s · Ctrl-C to quit`, "2")}`);
      await new Promise<void>((r) => {
        const timer = setTimeout(r, everyMs);
        stop.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            r();
          },
          { once: true },
        );
      });
    }
  } finally {
    stop.dispose();
  }
  return 0;
}

// savings ------------------------------------------------------------------------------------

export interface SavingsServer {
  server: string;
  variant: string;
  rssBytes: number;
  /** live: measured now; sample: what mcpd measured the last time it ran. */
  source: "live" | "sample";
  measuredAt: string;
  sessions: number;
}

export interface Savings {
  running: true;
  agentSessions: number;
  /** Sessions that sent no client PID: they cannot be told apart, so they are left out. */
  unidentifiedSessions: number;
  withTurno: { totalBytes: number; mcpdBytes: number; serversBytes: number; runningServers: number };
  withoutTurnoBytes: number;
  savedBytes: number;
  savedPercent: number | null;
  servers: SavingsServer[];
  /** Servers the estimate needs but turno never saw running, so they are not counted. */
  unmeasured: string[];
  estimate: string;
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * The comparison: mcpd plus its children now, against an estimate of the same agent sessions
 * without the gateway, where each starts its own copy of every stdio server its profile gets.
 */
export async function computeSavings(status: Status, procs: ProcTable, manifest: import("../../core/manifest.js").Manifest, now = new Date()): Promise<Savings> {
  const { treeRss } = await import("../../mcpd/rss.js");
  const { servesProfile, variantKey } = await import("../../core/manifest.js");
  const live = new Map<string, number[]>();
  for (const i of status.instances) {
    const rss = i.pid ? treeRss(procs, i.pid) : undefined;
    if (rss) live.set(`${i.server}@${i.variant}`, [...(live.get(`${i.server}@${i.variant}`) ?? []), rss]);
  }
  const samples = status.serverRss ?? {};
  const rssOf = (name: string, variant: string): { bytes: number; source: "live" | "sample"; at: string } | undefined => {
    for (const key of [`${name}@${variant}`, `${name}@default`]) {
      const l = live.get(key);
      if (l) return { bytes: Math.round(avg(l)), source: "live", at: now.toISOString() };
      const s = samples[key];
      if (s) return { bytes: s.bytes, source: "sample", at: s.at };
    }
    // Any variant of the server: same program, other credentials.
    const anyLive = [...live].find(([k]) => k.startsWith(`${name}@`));
    if (anyLive) return { bytes: Math.round(avg(anyLive[1])), source: "live", at: now.toISOString() };
    const anySample = Object.entries(samples).find(([k]) => k.startsWith(`${name}@`));
    return anySample ? { bytes: anySample[1].bytes, source: "sample", at: anySample[1].at } : undefined;
  };
  const agents = status.agents ?? [];
  const identified = agents.filter((a) => a.pid !== null);
  const per = new Map<string, SavingsServer>();
  const unmeasured = new Set<string>();
  let without = 0;
  for (const a of identified) {
    for (const def of Object.values(manifest.servers)) {
      if (def.kind !== "stdio" || def.builtin) continue;
      if (!servesProfile(def, a.profile ?? "")) continue;
      const variant = variantKey(def, a.profile ?? undefined);
      const m = rssOf(def.name, variant);
      if (!m) {
        unmeasured.add(def.name);
        continue;
      }
      without += m.bytes;
      const key = `${def.name}@${variant}`;
      const row = per.get(key) ?? { server: def.name, variant, rssBytes: m.bytes, source: m.source, measuredAt: m.at, sessions: 0 };
      row.sessions++;
      per.set(key, row);
    }
  }
  const mcpdBytes = procs.get(status.pid)?.rss ?? 0;
  const total = treeRss(procs, status.pid) ?? mcpdBytes;
  const saved = without - total;
  const n = identified.length;
  return {
    running: true,
    agentSessions: n,
    unidentifiedSessions: agents.length - n,
    withTurno: { totalBytes: total, mcpdBytes, serversBytes: total - mcpdBytes, runningServers: status.instances.filter((i) => i.pid).length },
    withoutTurnoBytes: without,
    savedBytes: saved,
    savedPercent: without > 0 ? Math.round((saved / without) * 100) : null,
    servers: [...per.values()].sort((a, b) => b.rssBytes * b.sessions - a.rssBytes * a.sessions),
    unmeasured: [...unmeasured].sort(),
    estimate:
      `Estimate: without the gateway, every live agent session (${n} now) starts its own copy of each stdio server its profile uses, ` +
      "so it is sessions x per-server RSS (measured now, or the last time the server ran under mcpd).",
  };
}

export async function savings(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, SAVINGS_FLAGS, 0);
  const json = bool(p, "json");
  const status = await fetchStatus(io.env);
  if (!status) return notRunning(io, json);
  const procs = await measure(io.env);
  if (!procs) {
    if (json) printJson(io, { running: true, error: MEMORY_UNKNOWN });
    else io.err(`turno: ${MEMORY_UNKNOWN}`);
    return 1;
  }
  const { loadManifestSafe } = await import("../../mcpd/daemon.js");
  const state = loadManifestSafe(io.env);
  if (state.error && !json) io.err(`${paint(io, "warning", "33")}: mcp.toml is invalid, so the estimate uses the ${state.source}: ${state.error}`);
  const s = await computeSavings(status, procs, state.manifest);
  if (json) {
    printJson(io, s);
    return 0;
  }
  const w = s.withTurno;
  io.out(`${paint(io, "With turno:", "1")}     ${memory(w.totalBytes).padStart(7)}  (mcpd ${memory(w.mcpdBytes)} + ${w.runningServers} running server${w.runningServers === 1 ? "" : "s"} ${memory(w.serversBytes)})`);
  if (!s.agentSessions) {
    io.out("No agent session is connected to mcpd right now, so there is nothing to compare. Open one and run this again.");
    if (s.unidentifiedSessions) io.out(`(${s.unidentifiedSessions} session${s.unidentifiedSessions === 1 ? "" : "s"} sent no client PID and cannot be counted.)`);
    return 0;
  }
  io.out(`${paint(io, "Without turno:", "1")}  ${memory(s.withoutTurnoBytes).padStart(7)}  (estimate for ${s.agentSessions} agent session${s.agentSessions === 1 ? "" : "s"})`);
  const label = s.savedBytes >= 0 ? "Saved:" : "Extra:";
  io.out(`${paint(io, label, "1")}${" ".repeat(15 - label.length)} ${memory(Math.abs(s.savedBytes)).padStart(7)}${s.savedPercent !== null && s.savedBytes >= 0 ? `  (${s.savedPercent}%)` : ""}`);
  io.out(s.estimate);
  if (s.savedBytes < 0) io.out("With this few sessions mcpd costs more than it saves; the saving grows with each session that shares a server.");
  for (const r of s.servers) {
    io.out(`  ${`${r.server}@${r.variant}`.padEnd(24)} ${memory(r.rssBytes).padStart(7)} x ${r.sessions} = ${memory(r.rssBytes * r.sessions)}${r.source === "sample" ? `  (measured ${r.measuredAt.slice(0, 10)})` : ""}`);
  }
  if (s.unmeasured.length) io.out(`Not counted (never measured while running): ${s.unmeasured.join(", ")}. Use them once and run this again.`);
  if (s.unidentifiedSessions) io.out(`Not counted: ${s.unidentifiedSessions} session${s.unidentifiedSessions === 1 ? "" : "s"} without a client PID.`);
  return 0;
}

import type { CallRecord } from "../../mcpd/calllog.js";
import type { ProcTable } from "../../mcpd/rss.js";
import { type FlagSpec, JSON_FLAG, TAIL, WATCH, bool, count, parseFlags, str } from "../args.js";
import { Exit } from "../exit.js";
import { type Io, fail, paint } from "../io.js";
import { emit, emitLine, jsonOutput } from "../output.js";
import { type IconName, duration as elapsed, padEnd, style } from "../style.js";

/**
 * Observability subcommands of `turno mcp` (ADR 0026): `log` reads the call log mcpd keeps,
 * `top` shows what each running server costs, `savings` compares mcpd's memory with what the
 * same agent sessions would use without the gateway.
 */

export const LOG_FLAGS: FlagSpec = {
  follow: { type: "boolean", short: "f" },
  ...TAIL,
  server: { type: "string" },
  profile: { type: "string" },
  ...JSON_FLAG,
};
export const TOP_FLAGS: FlagSpec = { once: { type: "boolean" }, ...WATCH, ...JSON_FLAG };
export const SAVINGS_FLAGS: FlagSpec = { ...JSON_FLAG };

/** `turno mcp log --json`: one call record per line (ADR 0045). */
export const LOG_JSON = jsonOutput([
  "time",
  "agent",
  "profile",
  "pid",
  "server",
  "variant",
  "tool",
  "durationMs",
  "outcome",
  "error",
  "requestBytes",
  "responseBytes",
]);
/** `turno mcp top --json`; `{ running: false }` when mcpd is down. */
export const TOP_JSON = jsonOutput(["running", "mcpd", "instances", "memoryKnown", "memoryPressure"]);
/** `turno mcp savings --json`; `{ running: false }` or `{ running: true, error }` when it cannot tell. */
export const SAVINGS_JSON = jsonOutput([
  "running",
  "agentSessions",
  "unidentifiedSessions",
  "withTurno",
  "withoutTurnoBytes",
  "savedBytes",
  "savedPercent",
  "servers",
  "unmeasured",
  "estimate",
  "error",
]);

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

/** Abort on Ctrl-C, for the commands that keep running. */
function untilInterrupted(): { signal: AbortSignal; dispose(): void } {
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once("SIGINT", stop);
  return { signal: ac.signal, dispose: () => process.off("SIGINT", stop) };
}

// log ----------------------------------------------------------------------------------------

const OUTCOME: Record<string, { icon: IconName; paint: "ok" | "err" | "warn" | "muted" }> = {
  ok: { icon: "ok", paint: "ok" },
  error: { icon: "err", paint: "err" },
  timeout: { icon: "warn", paint: "warn" },
  cancelled: { icon: "skip", paint: "muted" },
};

/** Column widths of `turno mcp log` on a terminal, chosen once so `--follow` lines stay aligned. */
export interface LogLayout {
  /** Time only (HH:MM:SS) when every call is from today; MM-DD HH:MM:SS otherwise. */
  today: boolean;
  server: number;
  tool: number;
  profile: number;
  agent: number;
  sizes: number;
  showAgent: boolean;
  showSizes: boolean;
}

const sizesText = (r: CallRecord) => `${size(r.requestBytes)} → ${size(r.responseBytes)}`;
const serverText = (r: CallRecord) => (r.variant && r.variant !== "default" ? `${r.server}@${r.variant}` : r.server);
const OUTCOME_W = 11;
const DURATION_W = 5;
const GAP = 2;

/**
 * Widths for these calls on this terminal: each name column as wide as its widest value within
 * a cap, narrowed until the line fits, then sizes and the agent added while they fit (on a
 * narrow terminal the agent goes first, then the sizes).
 */
export function logLayout(
  io: Pick<Io, "env" | "isTty" | "color">,
  records: readonly CallRecord[],
  now = new Date(),
): LogLayout {
  const { width } = style(io);
  const day = (iso: string) => {
    const d = new Date(iso);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  };
  const widest = (f: (r: CallRecord) => string, min: number, max: number, none: number) =>
    records.length ? Math.min(max, Math.max(min, ...records.map((r) => f(r).length))) : none;
  const l: LogLayout = {
    today: records.every((r) => day(r.time)),
    server: widest(serverText, 6, 18, 12),
    tool: widest((r) => r.tool ?? "-", 4, 24, 16),
    profile: widest((r) => r.profile ?? "-", 4, 12, 8),
    agent: widest((r) => r.agent ?? "-", 5, 16, 12),
    sizes: widest(sizesText, 5, 21, 17),
    showAgent: false,
    showSizes: false,
  };
  const core = () => (l.today ? 8 : 14) + OUTCOME_W + DURATION_W + l.server + l.tool + l.profile + GAP * 5;
  while (core() > width && (l.tool > 10 || l.server > 8)) {
    if (l.tool >= l.server && l.tool > 10) l.tool--;
    else l.server--;
  }
  l.showSizes = core() + GAP + l.sizes <= width;
  l.showAgent = l.showSizes && core() + GAP * 2 + l.sizes + l.agent <= width;
  return l;
}

/** Cut text to `w` columns with an ellipsis. */
const clip = (text: string, w: number) => (text.length > w ? `${text.slice(0, Math.max(0, w - 1))}…` : text);

/**
 * One call as a line: local time, outcome, duration, server, tool, profile, agent, sizes, error.
 * Plain text keeps the fixed widths scripts read; a terminal uses `layout` (logLayout) so every
 * line fits, and puts an error on its own line under the call.
 */
export function formatCall(io: Io, r: CallRecord, localTime: (iso: string) => string, layout?: LogLayout): string {
  const s = style(io);
  const server = serverText(r);
  if (!s.color) {
    const cells = [
      localTime(r.time),
      r.outcome.padEnd(9),
      `${r.durationMs} ms`.padStart(9),
      server.padEnd(18),
      (r.tool ?? "-").padEnd(22),
      (r.profile ?? "-").padEnd(10),
      (r.agent ?? "-").padEnd(16),
      `${size(r.requestBytes)} in, ${size(r.responseBytes)} out`,
    ];
    return `${cells.join(" ")}${r.error ? `  ${r.error}` : ""}`;
  }
  const l = layout ?? logLayout(io, [r]);
  const o = OUTCOME[r.outcome];
  const time = localTime(r.time);
  const slow = r.durationMs >= 10_000 ? s.warn : (t: string) => t;
  const cells = [
    s.muted(l.today ? time.slice(11) : time.slice(5)),
    padEnd(o ? `${s.icon(o.icon)} ${s[o.paint](r.outcome)}` : r.outcome, OUTCOME_W),
    slow(elapsed(r.durationMs).padStart(DURATION_W)),
    padEnd(s.bold(clip(server, l.server)), l.server),
    padEnd(clip(r.tool ?? "-", l.tool), l.tool),
    padEnd(clip(r.profile ?? "-", l.profile), l.profile),
    ...(l.showAgent ? [padEnd(s.muted(clip(r.agent ?? "-", l.agent)), l.agent)] : []),
    ...(l.showSizes ? [s.muted(sizesText(r))] : []),
  ];
  const line = cells.join(" ".repeat(GAP)).trimEnd();
  if (!r.error) return line;
  return `${line}\n${s.wrap(" ".repeat((l.today ? 8 : 14) + GAP), s.err(r.error))}`;
}

/** `turno mcp log`; `signal` stops `--follow` (Ctrl-C when not given). */
export async function log(args: string[], io: Io, signal?: AbortSignal): Promise<number> {
  const p = parseFlags(args, LOG_FLAGS, 0);
  const n = count(p, "tail", 20);
  const filter = {
    ...(str(p, "server") ? { server: str(p, "server") } : {}),
    ...(str(p, "profile") ? { profile: str(p, "profile") } : {}),
  };
  const json = bool(p, "json");
  const { daemonFiles, loadConfigSafe } = await import("../../mcpd/state.js");
  const { followCalls, readCalls } = await import("../../mcpd/calllog.js");
  const { localTime } = await import("./mcpd.js");
  const file = daemonFiles(io.env).calls;
  if (!loadConfigSafe(io.env).config.mcpd.callLog) {
    io.err(
      `${paint(io, "note", "33")}: the call log is off (call_log = false under [mcpd] in config.toml); mcpd records no new calls`,
    );
  }
  const records = readCalls(file, n, filter);
  const layout = logLayout(io, records);
  const print = (r: CallRecord) => (json ? emitLine(io, p, LOG_JSON, r) : io.out(formatCall(io, r, localTime, layout)));
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

/** `/status` `memoryPressure` (ADR 0028); absent from an mcpd older than 0.2. */
interface StatusPressure {
  level: "normal" | "warn" | "critical" | null;
  checkedAt: number | null;
  idleUnderPressure: number;
  idleCap: number | null;
}

interface Status {
  pid: number;
  version?: string;
  startedAt?: string;
  sessions: number;
  agents?: StatusAgent[];
  memoryPressure?: StatusPressure;
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

/** mcpd does not answer: exit 5 (ADR 0045). */
function notRunning(io: Io, json: Parameters<typeof emit>[1] | false, out = TOP_JSON): number {
  if (json !== false) emit(io, json, out, { running: false });
  else io.out("mcpd is not running (turno mcp daemon start)");
  return Exit.gatewayDown;
}

const MEMORY_UNKNOWN = "memory is unknown: ps is not available and there is no /proc";

// top ----------------------------------------------------------------------------------------

export interface TopSnapshot {
  running: true;
  mcpd: {
    pid: number;
    version: string | null;
    uptimeSeconds: number | null;
    sessions: number;
    agents: number;
    rssBytes: number | null;
    totalRssBytes: number | null;
  };
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
  /**
   * Memory pressure as mcpd sees it: `level` null when `mcpd.idle_under_pressure` is off (not
   * watched); `idleCapSeconds` the idle limit every server gets now, null when they keep their
   * own. Null as a whole when the running mcpd does not report it.
   */
  memoryPressure?: {
    level: "normal" | "warn" | "critical" | null;
    idleUnderPressureSeconds: number;
    idleCapSeconds: number | null;
  } | null;
}

export async function topSnapshot(
  status: Status,
  procs: ProcTable | undefined,
  now = Date.now(),
): Promise<TopSnapshot> {
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
    memoryPressure: status.memoryPressure
      ? {
          level: status.memoryPressure.level,
          idleUnderPressureSeconds: status.memoryPressure.idleUnderPressure,
          idleCapSeconds: status.memoryPressure.idleCap,
        }
      : null,
  };
}

/** The memory pressure line under the top header; nothing while mcpd does not watch it. */
function pressureLine(s: ReturnType<typeof style>, p: TopSnapshot["memoryPressure"]): string | undefined {
  if (!p?.level) return undefined;
  if (p.level === "normal" || p.idleCapSeconds === null)
    return s.note("ok", s.muted(`memory pressure ${p.level}: servers keep their own idle limits`));
  const text = `memory pressure ${p.level}: idle servers stop after ${duration(p.idleCapSeconds)} (mcpd.idle_under_pressure)`;
  return p.level === "critical" ? s.note("err", s.err(text)) : s.note("warn", s.warn(text));
}

export function renderTop(io: Io, t: TopSnapshot): string[] {
  const s = style(io);
  const m = t.mcpd;
  const head = [
    s.bold(s.accent(`mcpd pid ${m.pid}`)),
    m.version ? s.muted(`v${m.version}`) : "",
    m.uptimeSeconds !== null ? `up ${duration(m.uptimeSeconds)}` : "",
    `${s.bold(memory(m.rssBytes))} own, ${s.bold(memory(m.totalRssBytes))} with servers`,
    `${m.sessions} session${m.sessions === 1 ? "" : "s"} from ${m.agents} agent${m.agents === 1 ? "" : "s"}`,
  ].filter(Boolean);
  const out = [s.wrap("", head.join(s.muted(" · ")))];
  if (!t.memoryKnown) out.push(s.note("warn", `note: ${MEMORY_UNKNOWN}`));
  const pressure = pressureLine(s, t.memoryPressure);
  if (pressure) out.push(pressure);
  if (!t.instances.length) {
    out.push(s.muted("  no servers running (they start on first use)"));
    return out;
  }
  // Column titles: muted lowercase on a terminal, as in turno status; uppercase in plain text.
  const rows = [
    ["SERVER", "VARIANT", "SCOPE", "PID", "RSS", "SESSIONS", "IN FLIGHT", "IDLE", "RESTARTS", "UP", "HELD BY"].map(
      (h) => s.muted(s.color ? h.toLowerCase() : h),
    ),
  ];
  for (const i of t.instances) {
    rows.push([
      `${s.icon("on")}${s.color ? " " : ""}${s.bold(i.server)}`,
      i.variant === "default" ? s.muted(i.variant) : i.variant,
      i.scope,
      i.pid ? String(i.pid) : s.muted("-"),
      i.pid ? memory(i.rssBytes) : s.muted("in mcpd"),
      String(i.sessions),
      i.inflight ? s.accent(String(i.inflight)) : s.muted("0"),
      duration(i.idleSeconds),
      i.restarts ? s.warn(String(i.restarts)) : s.muted("0"),
      duration(i.uptimeSeconds),
      i.heldBy ? `${i.heldBy.profile ?? "?"}/${i.heldBy.pid ?? "?"}` : "",
    ]);
  }
  const right = { align: "right" } as const;
  // Narrow terminals drop the holder, uptime, restarts and variant first.
  out.push(
    ...s.table(rows, {
      indent: 0,
      columns: [
        {},
        { drop: 1 },
        {},
        right,
        right,
        right,
        right,
        { ...right, drop: 3 },
        { ...right, drop: 2 },
        { ...right, drop: 4 },
        { drop: 5 },
      ],
    }),
  );
  return out;
}

/**
 * `turno mcp top`: refreshes every 2 s in a terminal until Ctrl-C; one snapshot otherwise.
 * `--watch --json` prints one snapshot per line (NDJSON) every 2 s until Ctrl-C.
 */
export async function top(args: string[], io: Io, signal?: AbortSignal, everyMs = 2000): Promise<number> {
  const p = parseFlags(args, TOP_FLAGS, 0);
  const json = bool(p, "json");
  const watch = bool(p, "watch");
  if (watch && bool(p, "once")) return fail("--watch and --once do not go together");
  const once = (json && !watch) || bool(p, "once") || (!io.isTty && !watch);
  const snap = async (): Promise<TopSnapshot | undefined> => {
    const s = await fetchStatus(io.env);
    return s ? topSnapshot(s, await measure(io.env)) : undefined;
  };
  if (once) {
    const t = await snap();
    if (!t) return notRunning(io, json ? p : false);
    if (json) emit(io, p, TOP_JSON, t);
    else for (const l of renderTop(io, t)) io.out(l);
    return 0;
  }
  if (json) return watchTop(io, p, snap, signal, everyMs);
  const stop = signal ? { signal, dispose() {} } : untilInterrupted();
  try {
    while (!stop.signal.aborted) {
      const t = await snap();
      const lines = t ? renderTop(io, t) : ["mcpd is not running (turno mcp daemon start); trying again"];
      io.out(`\x1b[H\x1b[2J${lines.join("\n")}\n${style(io).muted(`every ${everyMs / 1000}s · Ctrl-C to quit`)}`);
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

/** `top --watch --json`: a snapshot per line, or `{ running: false }` while mcpd is down. */
async function watchTop(
  io: Io,
  p: Parameters<typeof emit>[1],
  snap: () => Promise<TopSnapshot | undefined>,
  signal: AbortSignal | undefined,
  everyMs: number,
): Promise<number> {
  const stop = signal ? { signal, dispose() {} } : untilInterrupted();
  try {
    while (!stop.signal.aborted) {
      emitLine(io, p, TOP_JSON, (await snap()) ?? { running: false });
      await sleep(everyMs, stop.signal);
    }
  } finally {
    stop.dispose();
  }
  return 0;
}

/** Wait `ms`, or less when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((r) => {
    const timer = setTimeout(r, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        r();
      },
      { once: true },
    );
  });
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
export async function computeSavings(
  status: Status,
  procs: ProcTable,
  manifest: import("../../core/manifest.js").Manifest,
  now = new Date(),
): Promise<Savings> {
  const { treeRss } = await import("../../mcpd/rss.js");
  const { servesProfile, variantKey } = await import("../../core/manifest.js");
  const live = new Map<string, number[]>();
  for (const i of status.instances) {
    const rss = i.pid ? treeRss(procs, i.pid) : undefined;
    if (rss) live.set(`${i.server}@${i.variant}`, [...(live.get(`${i.server}@${i.variant}`) ?? []), rss]);
  }
  const samples = status.serverRss ?? {};
  const rssOf = (
    name: string,
    variant: string,
  ): { bytes: number; source: "live" | "sample"; at: string } | undefined => {
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
      const row = per.get(key) ?? {
        server: def.name,
        variant,
        rssBytes: m.bytes,
        source: m.source,
        measuredAt: m.at,
        sessions: 0,
      };
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
    withTurno: {
      totalBytes: total,
      mcpdBytes,
      serversBytes: total - mcpdBytes,
      runningServers: status.instances.filter((i) => i.pid).length,
    },
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
  if (!status) return notRunning(io, json ? p : false, SAVINGS_JSON);
  const procs = await measure(io.env);
  if (!procs) {
    if (json) emit(io, p, SAVINGS_JSON, { running: true, error: MEMORY_UNKNOWN });
    else io.err(`turno: ${MEMORY_UNKNOWN}`);
    return 1;
  }
  const { loadManifestSafe } = await import("../../mcpd/daemon.js");
  const state = loadManifestSafe(io.env);
  if (state.error && !json)
    io.err(
      `${paint(io, "warning", "33")}: mcp.toml is invalid, so the estimate uses the ${state.source}: ${state.error}`,
    );
  const s = await computeSavings(status, procs, state.manifest);
  if (json) {
    emit(io, p, SAVINGS_JSON, s);
    return 0;
  }
  const w = s.withTurno;
  io.out(
    `${paint(io, "With turno:", "1")}     ${memory(w.totalBytes).padStart(7)}  (mcpd ${memory(w.mcpdBytes)} + ${w.runningServers} running server${w.runningServers === 1 ? "" : "s"} ${memory(w.serversBytes)})`,
  );
  if (!s.agentSessions) {
    io.out(
      "No agent session is connected to mcpd right now, so there is nothing to compare. Open one and run this again.",
    );
    if (s.unidentifiedSessions)
      io.out(
        `(${s.unidentifiedSessions} session${s.unidentifiedSessions === 1 ? "" : "s"} sent no client PID and cannot be counted.)`,
      );
    return 0;
  }
  io.out(
    `${paint(io, "Without turno:", "1")}  ${memory(s.withoutTurnoBytes).padStart(7)}  (estimate for ${s.agentSessions} agent session${s.agentSessions === 1 ? "" : "s"})`,
  );
  const label = s.savedBytes >= 0 ? "Saved:" : "Extra:";
  io.out(
    `${paint(io, label, "1")}${" ".repeat(15 - label.length)} ${memory(Math.abs(s.savedBytes)).padStart(7)}${s.savedPercent !== null && s.savedBytes >= 0 ? `  (${s.savedPercent}%)` : ""}`,
  );
  io.out(s.estimate);
  if (s.savedBytes < 0)
    io.out(
      "With this few sessions mcpd costs more than it saves; the saving grows with each session that shares a server.",
    );
  for (const r of s.servers) {
    io.out(
      `  ${`${r.server}@${r.variant}`.padEnd(24)} ${memory(r.rssBytes).padStart(7)} x ${r.sessions} = ${memory(r.rssBytes * r.sessions)}${r.source === "sample" ? `  (measured ${r.measuredAt.slice(0, 10)})` : ""}`,
    );
  }
  if (s.unmeasured.length)
    io.out(`Not counted (never measured while running): ${s.unmeasured.join(", ")}. Use them once and run this again.`);
  if (s.unidentifiedSessions)
    io.out(
      `Not counted: ${s.unidentifiedSessions} session${s.unidentifiedSessions === 1 ? "" : "s"} without a client PID.`,
    );
  return 0;
}

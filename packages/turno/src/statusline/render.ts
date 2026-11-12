/**
 * Two-row status line for Claude Code. Pure rendering: everything it shows comes in through
 * RenderInput, which `collect()` in ../cli/commands/statusline.ts fills from disk and git.
 *
 *   1. account: profile and plan, 5 h and weekly usage of THAT account, context, cache,
 *               turns left, and a warning when a fallback or the wrong account is in use
 *   2. session: project and worktree, branch, edits, model and effort, and real cost
 */

// 256-color palette: light text for neutral data and one hue per kind of data.
const TEXT = 252;
const MUTED = 246;
const SEP = 240;
const PROJECT = 75;
const WORKTREE = 110;
const BRANCH = 80;
const MODEL = 183;
const EFFORT = 213;
const OK = 114;
const WARN = 221;
const BAD = 203;
const WARM = 215;
const COLD = 117;
const COST = 150;

/** Pill backgrounds for profiles without a configured color, assigned in config order. */
export const PILL_DEFAULTS = [25, 28, 91, 30, 136, 124];
export const NAMED_COLORS: Record<string, number> = {
  blue: 25,
  green: 28,
  violet: 91,
  purple: 91,
  cyan: 30,
  yellow: 136,
  red: 124,
  orange: 166,
  gray: 240,
  // Spanish names accepted for configs migrated from the original tool
  azul: 25,
  verde: 28,
  violeta: 91,
  morado: 91,
  cian: 30,
  amarillo: 136,
  rojo: 124,
};

type IconSet = Record<string, string>;
const cp = (n: number) => String.fromCodePoint(n);
export const NERD: IconSet = {
  acct: cp(0xf2bd),
  h5: cp(0xf252),
  d7: cp(0xf073),
  rst: cp(0xf0450),
  batt: cp(0xf242),
  swap: cp(0xf0ec),
  warn: cp(0xf071),
  ban: cp(0xf05e),
  ok: cp(0xf058),
  proj: cp(0xf401),
  wt: cp(0xf402),
  br: cp(0xe725),
  model: cp(0xf2db),
  brain: cp(0xf09d1),
  ctx: cp(0xf0e4),
  fire: cp(0xf0238),
  snow: cp(0xf0717),
  diff: cp(0xf440),
  cost: cp(0xf155),
  left: cp(0xe0b6),
  right: cp(0xe0b4),
};
export const UNICODE: IconSet = {
  acct: "◉",
  h5: "⧗",
  d7: "▦",
  rst: "↺",
  batt: "▮",
  swap: "⇄",
  warn: "⚠",
  ban: "⊘",
  ok: "✓",
  proj: "▣",
  wt: "⑂",
  br: "⎇",
  model: "◈",
  brain: "✦",
  ctx: "◔",
  fire: "♨",
  snow: "❄",
  diff: "±",
  cost: "",
  left: "",
  right: "",
};

export interface Window {
  used_percentage?: number;
  resets_at?: number;
}

export interface StatusData {
  session_id?: string;
  prompt_id?: string;
  cwd?: string;
  transcript_path?: string;
  workspace?: { current_dir?: string; project_dir?: string; repo?: { name?: string }; git_worktree?: unknown };
  model?: { display_name?: string };
  effort?: { level?: string };
  cost?: { total_cost_usd?: number; total_lines_added?: number; total_lines_removed?: number };
  context_window?: { used_percentage?: number; total_input_tokens?: number; context_window_size?: number };
  prompt_cache?: { caching_observed?: boolean; warm?: boolean; expires_at?: number; recache_tokens_if_cold?: number };
  rate_limits?: { five_hour?: Window; seven_day?: Window };
}

export interface RenderInput {
  data: StatusData;
  now: number;
  nerd: boolean;
  compact: boolean;
  /** Profile of this session ("" when unknown). */
  account: string;
  pill: number;
  plan: string;
  limits: { five_hour?: Window; seven_day?: Window };
  turnsLeft?: number;
  /** Profile the folder resolves to now, and the one its rule assigns. */
  chosen: string;
  assigned: string;
  exhaustedMine?: number;
  exhaustedAssigned?: number;
  branch: string;
  cost?: { total: number; sub: number };
  /** Local time formatter (injectable for tests). */
  when?: (epochSeconds: number) => string;
}

export function fg(n: number, text: string, bold = false): string {
  return text ? `\x1b[${bold ? "1;" : ""}38;5;${n}m${text}\x1b[0m` : "";
}

export function tokens(n: number | undefined): string {
  if (n === undefined || n === null) return "";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  return `${Math.round(n / 1e3)}k`;
}

export function rel(ts: number, now: number): string {
  const d = Math.trunc(ts - now);
  if (d <= 0) return "";
  const h = Math.floor(d / 3600);
  const m = Math.floor((d % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d${h % 24}h`;
  return h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

function level(pct: number): number {
  return pct < 50 ? OK : pct < 80 ? WARN : BAD;
}

function meter(pct: number, cells: number): string {
  const filled = Math.min(cells, Math.round((pct * cells) / 100));
  return "▰".repeat(filled) + "▱".repeat(cells - filled);
}

function money(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd).toLocaleString("en-US")}` : `$${usd.toFixed(2)}`;
}

function defaultWhen(ts: number): string {
  const d = new Date(ts * 1000);
  const day = d.toLocaleDateString("en-US", { weekday: "short" });
  return `${day} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function render(i: RenderInput): string {
  const I = i.nerd ? NERD : UNICODE;
  const gap = i.nerd ? "  " : " ";
  const div = fg(SEP, " │ ");
  const ic = (name: string, color: number) => (I[name] ? fg(color, `${I[name]}${gap}`) : "");
  const when = i.when ?? defaultWhen;
  const { data, now, compact } = i;

  // Row 1: account
  const row1: string[] = [];
  if (i.account) {
    const label = `${I.acct}${gap}${i.account}${i.plan ? ` · ${i.plan}` : ""}`;
    const body = `\x1b[48;5;${i.pill};1;38;5;255m ${label} \x1b[0m`;
    row1.push(i.nerd ? fg(i.pill, I.left!) + body + fg(i.pill, I.right!) : body);
    for (const [icon, w] of [
      ["h5", i.limits.five_hour],
      ["d7", i.limits.seven_day],
    ] as const) {
      if (!w || w.used_percentage === undefined || w.used_percentage === null) continue;
      let pct = Math.round(w.used_percentage);
      const reset = w.resets_at;
      if (reset && reset <= now) pct = 0; // the window already reset
      let seg = ic(icon, MUTED) + (compact ? "" : `${fg(level(pct), meter(pct, 8))} `) + fg(level(pct), `${pct}%`);
      if (reset && rel(reset, now) && !compact) seg += fg(MUTED, `  ${I.rst}${gap}${rel(reset, now)}`);
      row1.push(seg);
    }
  }

  const cw = data.context_window ?? {};
  const ctx = Math.round(cw.used_percentage ?? 0);
  const cells = compact ? 5 : 10;
  const filled = Math.min(cells, Math.floor((ctx * cells) / 100));
  let ctxSeg = ic("ctx", level(ctx)) + fg(level(ctx), `[${"#".repeat(filled)}${"-".repeat(cells - filled)}] ${ctx}%`);
  if (cw.total_input_tokens && cw.context_window_size && !compact) {
    ctxSeg += fg(TEXT, `  ${tokens(cw.total_input_tokens)}/${tokens(cw.context_window_size)}`);
  }
  row1.push(ctxSeg);

  const pc = data.prompt_cache ?? {};
  if (pc.caching_observed) {
    if (pc.warm && pc.expires_at && rel(pc.expires_at, now)) row1.push(ic("fire", WARM) + fg(WARM, rel(pc.expires_at, now)));
    else if (pc.recache_tokens_if_cold) row1.push(ic("snow", COLD) + fg(COLD, `+${tokens(pc.recache_tokens_if_cold)}`));
  }

  if (i.account) {
    const t = i.turnsLeft;
    if (t !== undefined && !compact) {
      row1.push(ic("batt", t < 10 ? BAD : OK) + fg(t < 10 ? BAD : OK, `~${Math.min(t, 99)}${t > 99 ? "+" : ""} turns`));
    }
    const { chosen, assigned } = i;
    if (chosen && i.account !== chosen) {
      if (i.exhaustedMine) row1.push(ic("warn", BAD) + fg(BAD, `exhausted · project uses ${chosen}`, true));
      else if (chosen === assigned) row1.push(ic("ok", OK) + fg(OK, `${chosen} is back`));
      else row1.push(ic("warn", WARN) + fg(WARN, `project uses ${chosen}`, true));
    } else if (chosen && chosen !== assigned) {
      const text = compact
        ? `for ${assigned}`
        : `fallback for ${assigned}${i.exhaustedAssigned ? ` until ${when(i.exhaustedAssigned)}` : ""}`;
      row1.push(ic("swap", WARN) + fg(WARN, text));
    } else if (i.exhaustedMine) {
      row1.push(ic("ban", BAD) + fg(BAD, `exhausted until ${when(i.exhaustedMine)}`, true));
    }
  }

  // Row 2: session
  const ws = data.workspace ?? {};
  const cwd = ws.current_dir ?? data.cwd ?? "";
  const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? "";
  const project = ws.repo?.name || base(ws.project_dir ?? cwd) || "?";
  let first = ic("proj", PROJECT) + fg(PROJECT, project, true);
  const wt = ws.git_worktree ? base(cwd) : ""; // git's own worktree name can be an internal id
  if (wt && wt !== project && !compact) first += `  ${ic("wt", WORKTREE)}${fg(WORKTREE, wt)}`;
  const row2 = [first];
  if (i.branch) {
    const b = compact && i.branch.length > 24 ? `${i.branch.slice(0, 23)}…` : i.branch;
    row2.push(ic("br", BRANCH) + fg(BRANCH, b));
  }
  const c = data.cost ?? {};
  const added = c.total_lines_added ?? 0;
  const removed = c.total_lines_removed ?? 0;
  if ((added || removed) && !compact) row2.push(`${ic("diff", MUTED)}${fg(OK, `+${added}`)} ${fg(BAD, `−${removed}`)}`);
  const model = (data.model?.display_name ?? "Claude").replace(/\s*\(.*?\)/g, "");
  const effort = data.effort?.level;
  row2.push(ic("model", MODEL) + fg(MODEL, model) + (effort ? `  ${ic("brain", EFFORT)}${fg(EFFORT, effort)}` : ""));
  if (i.cost) {
    let seg = ic("cost", COST) + fg(COST, money(i.cost.total), true);
    if (i.cost.sub >= 0.01 && !compact) seg += fg(MUTED, ` (sub $${Math.round(i.cost.sub).toLocaleString("en-US")})`);
    row2.push(seg);
  } else if (c.total_cost_usd !== undefined && c.total_cost_usd !== null) {
    row2.push(ic("cost", COST) + fg(COST, `$${c.total_cost_usd.toFixed(2)}`) + fg(MUTED, "…"));
  }

  return `${row1.join(div)}\n${row2.join(div)}\n`;
}

/** Turns left in the 5 h window, from how much the percentage rose over this session's last turns. */
export function turnsLeft(history: [string, number, number | null][]): number | undefined {
  const done = history.length >= 3 ? history.slice(0, -1) : history;
  const deltas: number[] = [];
  for (let k = 1; k < done.length; k++) {
    const a = done[k - 1]!;
    const b = done[k]!;
    if (a[2] && b[2] && Math.abs(a[2] - b[2]) < 120 && b[1] > a[1]) deltas.push(b[1] - a[1]);
  }
  if (deltas.length < 2) return undefined;
  const last = deltas.slice(-5);
  const avg = last.reduce((s, d) => s + d, 0) / last.length;
  const pct = history[history.length - 1]?.[1] ?? 0;
  return avg > 0.05 ? Math.trunc((100 - pct) / avg) : undefined;
}

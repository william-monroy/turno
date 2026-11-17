/**
 * The look of turno's own screens: semantic colors, status icons, section headers, key/value
 * rows, tables sized to the terminal, usage bars, a spinner and timings. Every command draws with
 * this so the CLI reads as one tool. Without colors (a pipe, NO_COLOR) the same layout comes out
 * as plain text with ASCII icons, stable for scripts and tests.
 *
 * Keep this file free of heavy imports: `turno --help` and `turno status` load it.
 */
import { type Io, colors } from "./io.js";

/** Which glyphs icons use: Nerd Font symbols, plain Unicode, or ASCII when colors are off. */
export type IconMode = "nerd" | "unicode" | "ascii";

export type IconName = "ok" | "warn" | "err" | "info" | "add" | "remove" | "on" | "off" | "arrow" | "next" | "skip";

const cp = (n: number) => String.fromCodePoint(n);

export const ICONS: Record<IconMode, Record<IconName, string>> = {
  nerd: {
    ok: cp(0xf00c),
    warn: cp(0xf071),
    err: cp(0xf00d),
    info: cp(0xf05a),
    add: "+",
    remove: "-",
    on: cp(0xf111),
    off: cp(0xf10c),
    arrow: cp(0xf061),
    next: cp(0xf0a9),
    skip: cp(0xf05e),
  },
  unicode: { ok: "✓", warn: "!", err: "✗", info: "•", add: "+", remove: "-", on: "●", off: "○", arrow: "→", next: "➜", skip: "–" },
  ascii: { ok: "ok", warn: "!", err: "x", info: "-", add: "+", remove: "-", on: "", off: "", arrow: "->", next: "", skip: "-" },
};

/** SGR codes of the semantic colors: the terminal's own palette, so dark and light themes both work. */
const CODES = { ok: "32", warn: "33", err: "31", accent: "36", muted: "2", faint: "90", bold: "1" } as const;

/** Background colors of profile pills (256-color), as the status line draws them. */
const PILL_DEFAULTS = [25, 28, 91, 30, 136, 124];
const NAMED_COLORS: Record<string, number> = {
  blue: 25,
  green: 28,
  violet: 91,
  purple: 91,
  cyan: 30,
  yellow: 136,
  red: 124,
  orange: 166,
  gray: 240,
  azul: 25,
  verde: 28,
  violeta: 91,
  morado: 91,
  cian: 30,
  amarillo: 136,
  rojo: 124,
};

/**
 * The 256-color code of a profile: its `color` in config.toml, or one of the defaults by its
 * place in the config. The same rule as the status line pill (`pillColor` in statusline.ts).
 */
export function profileColor(profiles: Record<string, { color?: string | number }>, name: string): number {
  const c = profiles[name]?.color;
  if (typeof c === "number") return c;
  if (typeof c === "string") {
    if (/^\d+$/.test(c)) return Number(c);
    const named = NAMED_COLORS[c.toLowerCase()];
    if (named !== undefined) return named;
  }
  const names = Object.keys(profiles);
  const idx = names.includes(name) ? names.indexOf(name) : [...name].reduce((a, ch) => a + ch.charCodeAt(0), 0);
  return PILL_DEFAULTS[idx % PILL_DEFAULTS.length]!;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI = /\x1b\[[0-9;]*m/g;

/** Text without its ANSI color codes. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Columns a string takes on screen (ANSI codes take none). */
export function visibleWidth(text: string): number {
  return [...stripAnsi(text)].length;
}

/** Pad to `width` visible columns. */
export function padEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export function padStart(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

/**
 * Columns of the terminal: COLUMNS, then the real terminal, then 80 (a pipe, a test). Never
 * below 40, so layouts keep a sane minimum.
 */
export function termWidth(io: Pick<Io, "env" | "isTty">): number {
  const env = Number(io.env.COLUMNS);
  if (Number.isInteger(env) && env > 0) return Math.max(40, env);
  const real = io.isTty ? process.stdout.columns : undefined;
  return real && real > 0 ? Math.max(40, real) : 80;
}

/** "420ms", "1.2s", "1m05s". */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** Level of a usage percentage: below 60 fine, below 85 a warning, then a problem. */
export function level(pct: number): "ok" | "warn" | "err" {
  return pct < 60 ? "ok" : pct < 85 ? "warn" : "err";
}

export interface Column {
  align?: "left" | "right";
  /** Columns with a drop rank go first when the table is wider than the terminal (highest first). */
  drop?: number;
}

export interface Style {
  /** ANSI colors are on. */
  color: boolean;
  icons: IconMode;
  /** Terminal columns. */
  width: number;
  bold(s: string): string;
  muted(s: string): string;
  accent(s: string): string;
  ok(s: string): string;
  warn(s: string): string;
  err(s: string): string;
  /** An icon, colored by its meaning when colors are on. */
  icon(name: IconName): string;
  /** `icon text`, or just the text when the icon has no plain form. */
  lead(name: IconName, text: string): string;
  /** A profile name in its own color: a pill like the status line's, or the bare name in plain text. */
  profile(name: string, color?: number): string;
  /** A section title: bold, with a faint rule after it on a terminal. */
  header(title: string): string;
  /** `  key   value` with the key padded to `keyWidth`. */
  kv(key: string, value: string, keyWidth: number, indent?: number): string;
  /** Aligned rows sized to the terminal; on a terminal, columns with `drop` go first when it is narrow. */
  table(rows: readonly (readonly string[])[], opts?: { columns?: Column[]; indent?: number; gap?: number }): string[];
  /** A usage bar colored by level, then the percentage. */
  bar(pct: number, cells?: number): string;
  /** `ok cliente  ...` checklist row: icon, then the text. */
  check(state: "ok" | "warn" | "err" | "skip" | "info", text: string): string;
}

export function style(io: Pick<Io, "env" | "isTty">, opts: { nerd?: boolean } = {}): Style {
  const color = colors(io);
  const icons: IconMode = !color ? "ascii" : opts.nerd ? "nerd" : "unicode";
  const width = termWidth(io);
  const sgr = (code: string) => (s: string) => (color && s ? `\x1b[${code}m${s}\x1b[0m` : s);
  const ok = sgr(CODES.ok);
  const warn = sgr(CODES.warn);
  const err = sgr(CODES.err);
  const accent = sgr(CODES.accent);
  const muted = sgr(CODES.muted);
  const faint = sgr(CODES.faint);
  const bold = sgr(CODES.bold);
  const ICON_COLOR: Partial<Record<IconName, (s: string) => string>> = {
    ok,
    warn,
    err,
    info: accent,
    add: ok,
    remove: err,
    on: ok,
    off: faint,
    arrow: faint,
    next: accent,
    skip: faint,
  };
  const icon = (name: IconName) => (ICON_COLOR[name] ?? ((s: string) => s))(ICONS[icons][name]);
  const iconWidth = Math.max(...(["ok", "warn", "err", "skip", "info"] as const).map((n) => visibleWidth(ICONS[icons][n])));

  const table: Style["table"] = (rows, o = {}) => {
    const indent = o.indent ?? 2;
    const gap = o.gap ?? 2;
    const cols = o.columns ?? [];
    const n = Math.max(0, ...rows.map((r) => r.length));
    let keep = Array.from({ length: n }, (_, i) => i);
    const widthOf = (i: number) => Math.max(0, ...rows.map((r) => visibleWidth(r[i] ?? "")));
    const total = (ks: number[]) => indent + ks.reduce((a, i) => a + widthOf(i), 0) + gap * Math.max(0, ks.length - 1);
    // Only a terminal drops columns: a pipe keeps everything for whoever reads it.
    while (color && total(keep) > width) {
      const droppable = keep.filter((i) => cols[i]?.drop !== undefined).sort((a, b) => cols[b]!.drop! - cols[a]!.drop!);
      if (!droppable.length) break;
      keep = keep.filter((i) => i !== droppable[0]);
    }
    const widths = new Map(keep.map((i) => [i, widthOf(i)]));
    return rows.map((r) => {
      const cells = keep.map((i, k) => {
        const cell = r[i] ?? "";
        const w = widths.get(i)!;
        if (cols[i]?.align === "right") return padStart(cell, w);
        return k === keep.length - 1 ? cell : padEnd(cell, w);
      });
      return (" ".repeat(indent) + cells.join(" ".repeat(gap))).trimEnd();
    });
  };

  return {
    color,
    icons,
    width,
    bold,
    muted,
    accent,
    ok,
    warn,
    err,
    icon,
    lead: (name, text) => (ICONS[icons][name] ? `${icon(name)} ${text}` : text),
    profile: (name, c) => (color && c !== undefined ? `\x1b[48;5;${c};1;38;5;255m ${name} \x1b[0m` : color ? bold(name) : name),
    header: (title) => {
      if (!color) return title;
      const rule = Math.max(0, Math.min(width, 80) - visibleWidth(title) - 1);
      return `${bold(title)} ${faint("─".repeat(rule))}`;
    },
    kv: (key, value, keyWidth, indent = 2) => `${" ".repeat(indent)}${muted(padEnd(key, keyWidth))}  ${value}`.trimEnd(),
    table,
    bar: (pct, cells = 10) => {
      const p = Math.min(Math.max(pct, 0), 100);
      const filled = Math.round((p * cells) / 100);
      const paint = { ok, warn, err }[level(p)];
      // A heavy rule on a terminal (colored, the rest faint); blocks in plain text, where only shape tells.
      const [on, off] = color ? ["━", "━"] : ["█", "░"];
      return `${paint(on.repeat(filled))}${faint(off.repeat(cells - filled))} ${paint(`${p.toFixed(0)}%`.padStart(4))}`;
    },
    check: (state, text) => `${padEnd(icon(state), iconWidth)} ${text}`,
  };
}

export interface Spinner {
  /** Change the text while it spins. */
  update(text: string): void;
  /** Stop and clear the line; returns the milliseconds it ran. */
  stop(): number;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * A spinner with the elapsed time on stderr, for steps that wait (the gateway starting). Only on
 * a terminal with colors: anywhere else it draws nothing, and the caller prints the result line.
 */
export function spinner(
  io: Pick<Io, "env" | "isTty">,
  text: string,
  opts: { write?: (s: string) => void; tty?: boolean; now?: () => number } = {},
): Spinner {
  const now = opts.now ?? Date.now;
  const start = now();
  const tty = opts.tty ?? Boolean(process.stderr.isTTY);
  const write = opts.write ?? ((s: string) => process.stderr.write(s));
  if (!tty || !colors(io)) return { update: () => {}, stop: () => now() - start };
  let current = text;
  let frame = 0;
  const draw = () => {
    const secs = ((now() - start) / 1000).toFixed(1);
    write(`\r\x1b[K\x1b[36m${FRAMES[frame++ % FRAMES.length]}\x1b[0m ${current} \x1b[2m${secs}s\x1b[0m`);
  };
  draw();
  const timer = setInterval(draw, 80);
  timer.unref?.();
  return {
    update: (t) => {
      current = t;
    },
    stop: () => {
      clearInterval(timer);
      write("\r\x1b[K");
      return now() - start;
    },
  };
}

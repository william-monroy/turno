/** Small helpers shared by command modules. Keep this file free of heavy imports. */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** A plain error with its exit code: main prints `turno: <message>` and returns `code`. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export interface Io {
  out: (line?: string) => void;
  err: (line?: string) => void;
  env: NodeJS.ProcessEnv;
  isTty: boolean;
  /** Ask a question and return the answer; only set when a person can answer (stdin is a TTY). */
  ask?: (question: string) => Promise<string>;
}

async function askStdin(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export function defaultIo(): Io {
  return {
    out: (line = "") => process.stdout.write(`${line}\n`),
    err: (line = "") => process.stderr.write(`${line}\n`),
    env: process.env,
    isTty: Boolean(process.stdout.isTTY),
    ...(process.stdin.isTTY && process.stderr.isTTY ? { ask: askStdin } : {}),
  };
}

/** Ask a yes/no question; false without a person to answer. */
export async function confirm(io: Io, question: string): Promise<boolean> {
  if (!io.ask) return false;
  const answer = (await io.ask(`${question} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

/** What a positional argument holds, for shell completion. */
export type ArgKind = "profile" | "profile-or-auto" | "dir" | "identity" | "server" | "stamp" | "terminal" | "key" | "shell" | "any";

/** Completion data of a command or subcommand. */
export interface Completion {
  args?: ArgKind[];
  /** Long flags, with the leading dashes. */
  flags?: string[];
}

/** A command module: `export const command: Command = { ... }`. */
export interface Command extends Completion {
  /** One line for `turno help`. */
  summary: string;
  usage: string;
  hidden?: boolean;
  /** Subcommand names (visible ones) with their completion data. */
  subcommands?: Record<string, Completion>;
  run(args: string[], io: Io): Promise<number>;
}

/**
 * Whether output gets ANSI colors: on a terminal, unless NO_COLOR is set (https://no-color.org).
 * FORCE_COLOR=1 colors a pipe too, and FORCE_COLOR=0 turns colors off on a terminal.
 */
export function colors(io: Pick<Io, "env" | "isTty">): boolean {
  if (io.env.NO_COLOR) return false;
  const force = io.env.FORCE_COLOR;
  if (force !== undefined && force !== "") return force !== "0" && force !== "false";
  return io.isTty;
}

export function paint(io: Io, text: string, code: string): string {
  return colors(io) ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export function fail(message: string): never {
  throw new UsageError(message);
}

/** "1 project", "2 projects". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/** Help text width. */
export const WIDTH = 80;

/** Break `text` into lines of at most `width` columns at spaces (a longer word stays whole). */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/**
 * Two-column rows (`  left  summary`) within WIDTH columns: summaries wrap under their
 * column, and a left side too wide for the column goes on its own line.
 */
export function columns(rows: readonly (readonly [string, string])[], indent = 2, maxLeft = 32, left?: number): string {
  const fit = rows.map(([l]) => l.length).filter((n) => n <= maxLeft);
  const w = left ?? Math.max(0, ...fit);
  const pad = " ".repeat(indent);
  const out: string[] = [];
  for (const [left, summary] of rows) {
    const col = indent + w + 2;
    const body = wrap(summary, Math.max(20, WIDTH - col));
    if (left.length > w) {
      const [first, ...more] = wrap(left, WIDTH - indent - 4);
      out.push(`${pad}${first}`);
      for (const l of more) out.push(`${pad}    ${l}`);
      for (const l of body) out.push(`${" ".repeat(col)}${l}`);
      continue;
    }
    out.push(`${pad}${left.padEnd(w)}  ${body[0]}`);
    for (const l of body.slice(1)) out.push(`${" ".repeat(col)}${l}`);
  }
  return out.join("\n");
}

/** Edit distance with adjacent transpositions (so "stauts" is 1 away from "status"). */
export function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/** The closest of `candidates` to `word` (at most 2 edits, 1 for words of 3 letters or less). */
export function closest(word: string, candidates: readonly string[]): string | undefined {
  const max = word.length <= 3 ? 1 : 2;
  let best: { c: string; d: number } | undefined;
  for (const c of candidates) {
    const d = distance(word.toLowerCase(), c);
    if (d <= max && (!best || d < best.d)) best = { c, d };
  }
  return best?.c;
}

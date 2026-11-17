import { parseArgs } from "node:util";
import { highlightJson } from "./highlight.js";
import { type Io, colors, fail } from "./io.js";

export type FlagSpec = Record<string, { type: "boolean" | "string"; short?: string; multiple?: boolean }>;

/** Flags shared by every command, so the same words mean the same thing everywhere. */
export const JSON_FLAG: FlagSpec = { json: { type: "boolean" } };
export const DRY_RUN: FlagSpec = { "dry-run": { type: "boolean" } };
export const FORCE: FlagSpec = { force: { type: "boolean" } };
export const TAIL: FlagSpec = { tail: { type: "string", short: "n" } };
export const WATCH: FlagSpec = { watch: { type: "boolean" } };

/**
 * Completion flags of a spec (`--name` for each long flag), so the parser and the shell
 * completion never disagree. Use it as `flags: flagsOf(SPEC)` next to `parseFlags(args, SPEC)`.
 */
export function flagsOf(...specs: FlagSpec[]): string[] {
  return specs.flatMap((s) => Object.keys(s)).map((k) => `--${k}`);
}

export interface Parsed {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
}

/**
 * Parse `args` against `spec` (long flags, `--flag=value`, short aliases). Unknown flags and
 * positionals beyond `max` are usage errors with a plain message.
 */
export function parseFlags(args: string[], spec: FlagSpec, max = Number.POSITIVE_INFINITY): Parsed {
  let parsed: Parsed;
  try {
    parsed = parseArgs({ args, options: spec, allowPositionals: true, strict: true }) as Parsed;
  } catch (err) {
    const msg = (err as Error).message.replace(/^Unknown option '(.+?)'.*$/s, "unknown option $1").replace(/\. To specify.*$/s, "");
    return fail(msg.replace(/^Option '(--[\w-]+)(?: <value>)?' argument missing$/, "$1 needs a value"));
  }
  if (parsed.positionals.length > max) fail(`unexpected argument '${parsed.positionals[max]}'`);
  return parsed;
}

export function bool(p: Parsed, name: string): boolean {
  return p.values[name] === true;
}

export function str(p: Parsed, name: string): string | undefined {
  const v = p.values[name];
  return typeof v === "string" ? v : undefined;
}

/** A positive integer flag such as --tail. */
export function count(p: Parsed, name: string, fallback: number): number {
  const v = str(p, name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || String(n) !== v.trim()) fail(`--${name} must be a positive integer`);
  return n;
}

/**
 * Print a value as indented JSON, colored when `io` colors (a terminal without NO_COLOR).
 * Given only an output function it prints plain JSON.
 */
export function printJson(io: Pick<Io, "out" | "env" | "isTty"> | Io["out"], value: unknown): void {
  const text: string | undefined = JSON.stringify(value, null, 2);
  const out = typeof io === "function" ? io : io.out;
  out(text !== undefined && typeof io !== "function" && colors(io) ? highlightJson(text) : text);
}

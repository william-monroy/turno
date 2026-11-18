/**
 * The `--json` contract (ADR 0045): every JSON a command prints goes through `emit` (one
 * indented document) or `emitLine` (one compact line, NDJSON for `--watch`, `--follow` and the
 * machine outputs status lines read). Each object carries `schemaVersion`; each element of a
 * list does, since a list has no room for it. `--json=fields` lists a command's fields and
 * `--json=a,b` keeps only those, as gh does. Keep this file light: commands load it eagerly.
 */
import type { Parsed } from "./args.js";
import { highlightJson } from "./highlight.js";
import { type Io, UsageError, colors } from "./io.js";

/** The key every JSON object turno prints carries. */
export const SCHEMA_KEY = "schemaVersion";

/** The `--json` schema of one command output. */
export interface JsonOutput {
  /**
   * Format version. Adding a field keeps it; removing or renaming one, or changing what a field
   * means, raises it and goes in the changelog.
   */
  version: number;
  /** The top-level fields (of each element, for a list), for --json=fields and --json=<a,b>. */
  fields: readonly string[];
}

export function jsonOutput(fields: readonly string[], version = 1): JsonOutput {
  return { version, fields };
}

/** The word after `--json=` that lists the fields instead of printing anything. */
const FIELDS_WORD = "fields";

/** A usage error about `--json` fields: main adds the list to the JSON error. */
export class JsonFieldError extends UsageError {
  constructor(
    message: string,
    readonly fields: readonly string[],
  ) {
    super(message);
  }
}

/**
 * The value of `--json=<value>` among a command's own arguments (not after `--`), undefined
 * without one. A bare `--json` gives "".
 */
export function jsonArg(args: readonly string[]): string | undefined {
  let found: string | undefined;
  for (const a of args) {
    if (a === "--") break;
    if (a === "--json") found ??= "";
    else if (a.startsWith("--json=")) found = a.slice("--json=".length);
  }
  return found;
}

/** The field list `--json=fields` prints, one per line after a header, like gh. */
function fieldLines(out: JsonOutput): string[] {
  return [
    "Fields for --json=<field,...> (schemaVersion is always there):",
    ...[...out.fields].sort().map((f) => `  ${f}`),
  ];
}

/**
 * The fields `--json=<value>` selects: undefined for all of them (bare --json), "list" for
 * --json=fields. An unknown field is a usage error that lists the known ones.
 */
export function selectFields(value: string | undefined, out: JsonOutput): string[] | "list" | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === FIELDS_WORD) return "list";
  const asked = value
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  const unknown = asked.filter((f) => f !== SCHEMA_KEY && !out.fields.includes(f));
  if (unknown.length) {
    const known = [...out.fields].sort();
    throw new JsonFieldError(
      `unknown JSON field${unknown.length > 1 ? "s" : ""} ${unknown.map((f) => `"${f}"`).join(", ")}; available: ${known.join(", ")}`,
      known,
    );
  }
  return asked;
}

/**
 * Before a command runs: answer `--json=fields` (true: the caller returns 0) and refuse an
 * unknown field (a usage error), so neither waits for the command's work.
 */
export function answerFields(args: readonly string[], out: JsonOutput | undefined, io: Pick<Io, "out">): boolean {
  if (!out) return false;
  const picked = selectFields(jsonArg(args), out);
  if (picked !== "list") return false;
  for (const l of fieldLines(out)) io.out(l);
  return true;
}

function stamp(value: unknown, out: JsonOutput, fields: readonly string[] | undefined): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const o = value as Record<string, unknown>;
  const kept = fields ? Object.fromEntries(fields.filter((f) => f !== SCHEMA_KEY && f in o).map((f) => [f, o[f]])) : o;
  return { [SCHEMA_KEY]: out.version, ...kept };
}

/** The value as printed: schemaVersion on the object (or on each element of a list), fields picked. */
export function shape(value: unknown, out: JsonOutput, json?: string): unknown {
  const picked = selectFields(json, out);
  const fields = picked === "list" ? undefined : picked;
  return Array.isArray(value) ? value.map((v) => stamp(v, out, fields)) : stamp(value, out, fields);
}

/** `--json=<value>` as parsed, for `emit`; a bare --json gives "". */
type JsonSource = Pick<Parsed, "json"> | string | undefined;

const jsonValue = (p: JsonSource): string | undefined => (typeof p === "object" ? p.json : p);

/**
 * Print a command's JSON: indented, colored on a terminal only (never in a pipe, even with
 * FORCE_COLOR, since programs read it). `--json=fields` prints the field list instead.
 */
export function emit(
  io: Pick<Io, "out" | "env" | "isTty" | "color">,
  p: JsonSource,
  out: JsonOutput,
  value: unknown,
): void {
  if (selectFields(jsonValue(p), out) === "list") {
    for (const l of fieldLines(out)) io.out(l);
    return;
  }
  const text = JSON.stringify(shape(value, out, jsonValue(p)), null, 2);
  io.out(io.isTty && colors(io) ? highlightJson(text) : text);
}

/**
 * `turno config get --json`: a config value as config.toml holds it, with no schemaVersion (its
 * shape is config.toml's, documented in docs/config.md). The one exception to the contract.
 */
export function emitConfigValue(io: Pick<Io, "out" | "env" | "isTty" | "color">, value: unknown): void {
  const text = JSON.stringify(value, null, 2);
  io.out(io.isTty && colors(io) ? highlightJson(text) : text);
}

/** Print one record as one compact line (NDJSON): `--watch --json`, `mcp log --json`, `resolve --json`. */
export function emitLine(io: Pick<Io, "out">, p: JsonSource, out: JsonOutput, value: unknown): void {
  io.out(JSON.stringify(shape(value, out, jsonValue(p))));
}

/** Each element of a list as its own line (NDJSON). */
export function emitLines(io: Pick<Io, "out">, p: JsonSource, out: JsonOutput, values: readonly unknown[]): void {
  for (const v of values) emitLine(io, p, out, v);
}

/** The JSON error object of the contract (`schemaVersion` 1), for stderr under --json. */
export function jsonError(
  message: string,
  exitCode: number,
  code: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({ [SCHEMA_KEY]: 1, error: { code, exitCode, message, ...extra } });
}

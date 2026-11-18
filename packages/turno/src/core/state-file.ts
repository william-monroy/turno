/**
 * Reading turno's own state files (ADR 0045): JSON that turno wrote earlier (locks, caches, the
 * managed-entries list, journal manifests, audit and call log lines). A file another program or
 * a crash left half-written, a hand edit, or a newer turno's format must never become a cast that
 * crashes later: each reader passes a small guard for the shape it needs and the format version
 * it understands, and gets the value, or a reason it cannot have it.
 *
 * Versions: an object may carry a top-level `version` number. A file without one is format 1
 * (everything written before versioning). A file whose version is above the reader's is from a
 * newer turno and is not read. Keep this file free of heavy imports: the status line uses it.
 */
import { readFileSync } from "node:fs";

/** A type guard for the shape a reader needs. */
export type Guard<T> = (v: unknown) => v is T;

/** Why a state file gave no value. `missing` is the normal first run. */
export type StateProblem = "missing" | "unreadable" | "corrupt" | "shape" | "newer";

export type StateResult<T> = { ok: true; value: T } | { ok: false; problem: StateProblem; message: string };

/** A state file that exists but cannot be used: main prints its message on one line. */
export class StateError extends Error {
  constructor(
    message: string,
    readonly problem: StateProblem,
  ) {
    super(message);
    this.name = "StateError";
  }
}

/** The format version of a parsed value: its `version` field, 1 without one. */
function formatVersion(v: unknown): number {
  const n = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as { version?: unknown }).version : undefined;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 1;
}

/** Check parsed JSON against a guard and a version; `label` names it in the message. */
function checkState<T>(v: unknown, guard: Guard<T>, version: number, label: string): StateResult<T> {
  const found = formatVersion(v);
  if (found > version)
    return {
      ok: false,
      problem: "newer",
      message: `${label} is format ${found}, from a newer turno (this one reads up to ${version})`,
    };
  if (!guard(v)) return { ok: false, problem: "shape", message: `${label} does not hold what turno expects` };
  return { ok: true, value: v };
}

/** Parse JSON text (one file, or one line of a log) and check it. */
export function parseState<T>(text: string, guard: Guard<T>, version: number, label: string): StateResult<T> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, problem: "corrupt", message: `${label} is not valid JSON` };
  }
  return checkState(v, guard, version, label);
}

/** Read and check a state file, saying what went wrong when it cannot be used. */
export function readStateResult<T>(file: string, guard: Guard<T>, version = 1): StateResult<T> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      return { ok: false, problem: "missing", message: `${file} does not exist` };
    return { ok: false, problem: "unreadable", message: `${file} cannot be read (${code ?? (err as Error).message})` };
  }
  return parseState(text, guard, version, file);
}

/**
 * The value of a state file, or undefined when it is missing or cannot be used. For caches and
 * hints, where the safe default is to act as if the file were not there.
 */
export function readState<T>(file: string, guard: Guard<T>, version = 1): T | undefined {
  const r = readStateResult(file, guard, version);
  return r.ok ? r.value : undefined;
}

/**
 * The value of a state file, undefined when it is missing, and a StateError (one clear line that
 * names the file and says to fix or remove it) when it exists but cannot be used. For state
 * whose loss would make turno act wrongly, such as the list of entries it may remove.
 */
export function requireState<T>(file: string, guard: Guard<T>, version = 1): T | undefined {
  const r = readStateResult(file, guard, version);
  if (r.ok) return r.value;
  if (r.problem === "missing") return undefined;
  const fix = r.problem === "newer" ? "upgrade turno (turno upgrade)" : "fix it by hand or remove it";
  throw new StateError(`${r.message}; ${fix}`, r.problem);
}

// Small guards shared by the readers ------------------------------------------------------------

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** An object whose every value passes `each` (a map such as `file -> names`). */
export function recordOf<T>(each: Guard<T>): Guard<Record<string, T>> {
  return (v: unknown): v is Record<string, T> => isRecord(v) && Object.values(v).every(each);
}

/** An object with these fields of these types (others are allowed, as newer files add fields). */
export function hasFields(
  v: unknown,
  fields: Record<string, "string" | "number" | "boolean" | "object" | "array">,
): v is Record<string, unknown> {
  if (!isRecord(v)) return false;
  return Object.entries(fields).every(([k, t]) => {
    const x = v[k];
    if (t === "array") return Array.isArray(x);
    if (t === "object") return isRecord(x);
    return typeof x === t;
  });
}

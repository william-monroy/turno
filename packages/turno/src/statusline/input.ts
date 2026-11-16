/**
 * Shape checks for everything the status line reads: the JSON Claude Code sends on stdin and the
 * cache files under the state dir. Each returns only fields of the expected type, so a field
 * that is null, missing or of another type is left out instead of breaking the line.
 */
import type { StatusData, Window } from "./render.js";

type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

/** Session ids become file names, so only plain ids are accepted. */
const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;
export function sessionId(v: unknown): string | undefined {
  return typeof v === "string" && SESSION_ID.test(v) ? v : undefined;
}

/** Copy the keys of `from` whose checked value is defined. */
function pick<T extends object>(from: Obj, checks: { [K in keyof T]: (v: unknown) => T[K] | undefined }): T {
  const out: Partial<T> = {};
  for (const k of Object.keys(checks) as (keyof T)[]) {
    const v = checks[k](from[k as string]);
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

export function window(v: unknown): Window | undefined {
  if (!isObj(v)) return undefined;
  const w = pick<Window>(v, { used_percentage: num, resets_at: num });
  return Object.keys(w).length ? w : undefined;
}

export function limits(v: unknown): { five_hour?: Window; seven_day?: Window } {
  if (!isObj(v)) return {};
  return pick<{ five_hour?: Window; seven_day?: Window }>(v, { five_hour: window, seven_day: window });
}

const sub =
  <T extends object>(checks: { [K in keyof T]: (v: unknown) => T[K] | undefined }) =>
  (v: unknown): T | undefined =>
    isObj(v) ? pick<T>(v, checks) : undefined;

/** The stdin payload, with every field checked. Anything that is not an object gives {}. */
export function sanitize(raw: unknown): StatusData {
  if (!isObj(raw)) return {};
  const data = pick<StatusData>(raw, {
    session_id: sessionId,
    prompt_id: str,
    cwd: str,
    transcript_path: str,
    workspace: sub<NonNullable<StatusData["workspace"]>>({
      current_dir: str,
      project_dir: str,
      repo: sub<{ name?: string }>({ name: str }),
      git_worktree: (v) => (v === null ? undefined : v),
    }),
    model: sub<{ display_name?: string }>({ display_name: str }),
    effort: sub<{ level?: string }>({ level: str }),
    cost: sub<NonNullable<StatusData["cost"]>>({ total_cost_usd: num, total_lines_added: num, total_lines_removed: num }),
    context_window: sub<NonNullable<StatusData["context_window"]>>({ used_percentage: num, total_input_tokens: num, context_window_size: num }),
    prompt_cache: sub<NonNullable<StatusData["prompt_cache"]>>({
      caching_observed: bool,
      warm: bool,
      expires_at: num,
      recache_tokens_if_cold: num,
    }),
    rate_limits: (v) => (isObj(v) ? limits(v) : undefined),
  });
  return data;
}

/** A turn history entry: [prompt id, 5 h percentage, 5 h reset or null]. */
export type Turn = [string, number, number | null];

export function turns(v: unknown): Turn[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (e): e is Turn => Array.isArray(e) && e.length === 3 && typeof e[0] === "string" && num(e[1]) !== undefined && (e[2] === null || num(e[2]) !== undefined),
  );
}

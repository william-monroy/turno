import { existsSync, readFileSync } from "node:fs";
import type { Journal } from "../core/journal.js";
import { parseJsonObject, realOr } from "../core/fsutil.js";
import { tildify } from "../core/paths.js";

export interface StatusLine {
  type: "command";
  command: string;
  refreshInterval?: number;
  padding?: number;
  [key: string]: unknown;
}

/** Refresh every 30 s so reset countdowns and the clock-driven parts stay current. */
const REFRESH_SECONDS = 30;

export function readSettings(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  return parseJsonObject(readFileSync(file, "utf8"), file);
}

export function currentStatusLine(file: string): StatusLine | undefined {
  try {
    const s = readSettings(file).statusLine as StatusLine | undefined;
    return s && typeof s === "object" ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a status line command runs turno's, with a bare or quoted path (`"/x/turno" statusline`). */
export function isTurnoStatusLine(s: StatusLine | undefined): boolean {
  return Boolean(s && /(^|[\s/"'])turno["']?\s+statusline(\s|$)/.test(s.command));
}

/**
 * A status line command as one row of doctor or the status screen shows it: "turno statusline"
 * for turno's own, "none" without one, and any other command without quotes, with paths under
 * HOME as ~ and cut to `max` characters.
 */
export function statusLineLabel(s: StatusLine | undefined, env: NodeJS.ProcessEnv, max = 60): string {
  if (!s) return "none";
  if (isTurnoStatusLine(s)) return "turno statusline";
  const text = s.command
    .replace(/["']/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => tildify(w, env))
    .join(" ");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** The entry to write: our command, keeping any other keys the user set (padding, ...). */
function wantedStatusLine(command: string, existing: StatusLine | undefined): StatusLine {
  return { ...(existing ?? {}), type: "command", command, refreshInterval: existing?.refreshInterval ?? REFRESH_SECONDS };
}

export interface WriteResult {
  file: string;
  changed: boolean;
  before?: StatusLine;
  after: StatusLine;
}

export function setStatusLine(file: string, command: string, journal: Journal): WriteResult {
  const settings = readSettings(file);
  const before = settings.statusLine as StatusLine | undefined;
  const after = wantedStatusLine(command, before);
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  const result: WriteResult = { file: realOr(file), changed, after, ...(before ? { before } : {}) };
  if (changed) journal.write(file, `${JSON.stringify({ ...settings, statusLine: after }, null, 2)}\n`);
  return result;
}

/**
 * Set the top-level `nerd_terminals` array of config.toml, keeping comments and tables: the
 * line is replaced in place, or added before the first table.
 */
export function withNerdTerminals(text: string, ids: string[]): string {
  const line = `nerd_terminals = [${ids.map((i) => JSON.stringify(i)).join(", ")}]`;
  const lines = text.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const top = firstTable < 0 ? lines.length : firstTable;
  for (let i = 0; i < top; i++) {
    if (/^\s*nerd_terminals\s*=/.test(lines[i]!)) {
      lines[i] = line;
      return lines.join("\n");
    }
  }
  if (firstTable < 0) {
    const body = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
    return `${body}${line}\n`;
  }
  let at = firstTable;
  while (at > 0 && lines[at - 1]!.trim() === "") at--;
  lines.splice(at, 0, line);
  return lines.join("\n");
}

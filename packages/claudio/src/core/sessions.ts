import { lstatSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Config, isValidProfileName, loadConfig } from "./config.js";
import { paths, profileDir } from "./paths.js";

/** A live Claude Code session, read from `<hub>/sessions/<pid>.json`. */
export interface LiveSession {
  pid: number;
  sessionId: string;
  name: string;
  status: string;
  cwd: string;
  entrypoint: string;
  procStart?: string;
  /**
   * Owning profile. From the launcher's run record, else the system profile. Undefined for
   * Claude Desktop sessions (they use their own account) and when no system profile is set.
   */
  profile?: string;
  /** How the profile was found. */
  source: "record" | "system" | "desktop";
}

/** Whether a process is alive. EPERM means it exists but belongs to someone else. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Parse Claude Code's `procStart` ("Wed Nov 11 00:28:56 2026"). Returns both readings in
 * epoch milliseconds: as UTC (what Claude Code writes) and as local time (in case it changes).
 */
export function parseProcStart(text: string): { utc: number; local: number } | undefined {
  const m = /^\s*[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(text);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1]!);
  if (month < 0) return undefined;
  const [day, h, mi, s, y] = [m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number];
  return { utc: Date.UTC(y, month, day, h, mi, s), local: new Date(y, month, day, h, mi, s).getTime() };
}

/**
 * The profile in a launcher's run record, when the record belongs to this process: its mtime
 * must be within 120 s of the process start, so a recycled PID never inherits an old record.
 */
export function recordProfile(pid: number, procStart: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const start = parseProcStart(procStart ?? "");
  if (!start) return undefined;
  const p = paths(env);
  // Sessions started by the bash launchers keep their records in the legacy folder.
  for (const dir of [p.runDir, join(p.legacyConfig, "run")]) {
    const file = join(dir, String(pid));
    try {
      const mtime = statSync(file).mtimeMs;
      if (Math.min(Math.abs(mtime - start.utc), Math.abs(mtime - start.local)) >= 120_000) continue;
      const name = readFileSync(file, "utf8").trim();
      if (isValidProfileName(name)) return name;
    } catch {
      /* not in this folder */
    }
  }
  return undefined;
}

/** Remove run records of processes that have ended. */
export function pruneRunRecords(env: NodeJS.ProcessEnv = process.env): void {
  const dir = paths(env).runDir;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (/^\d+$/.test(entry) && pidAlive(Number(entry))) continue;
    rmSync(join(dir, entry), { force: true, recursive: true });
  }
}

interface RawSession {
  pid?: unknown;
  sessionId?: unknown;
  name?: unknown;
  status?: unknown;
  cwd?: unknown;
  entrypoint?: unknown;
  procStart?: unknown;
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function readSessionFiles(dir: string): RawSession[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: RawSession[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, entry), "utf8")) as unknown;
      if (raw && typeof raw === "object") out.push(raw as RawSession);
    } catch {
      // being written or not a session file
    }
  }
  return out;
}

/** Live sessions in the hub, each attributed to a profile. Also prunes dead run records. */
export function liveSessions(env: NodeJS.ProcessEnv = process.env, config?: Config): LiveSession[] {
  const cfg = config ?? loadConfig(env);
  const sessions: LiveSession[] = [];
  for (const s of readSessionFiles(join(paths(env).hub, "sessions"))) {
    const pid = typeof s.pid === "number" ? s.pid : Number.parseInt(text(s.pid), 10);
    if (!pidAlive(pid)) continue;
    const entrypoint = text(s.entrypoint);
    const procStart = text(s.procStart) || undefined;
    const base = {
      pid,
      sessionId: text(s.sessionId),
      name: text(s.name),
      status: text(s.status) || "?",
      cwd: text(s.cwd),
      entrypoint,
      ...(procStart ? { procStart } : {}),
    };
    if (entrypoint !== "cli") {
      sessions.push({ ...base, source: "desktop" });
      continue;
    }
    const fromRecord = recordProfile(pid, procStart, env);
    if (fromRecord) sessions.push({ ...base, profile: fromRecord, source: "record" });
    else sessions.push({ ...base, ...(cfg.system ? { profile: cfg.system } : {}), source: "system" });
  }
  pruneRunRecords(env);
  sessions.sort((a, b) => (a.cwd === b.cwd ? displayName(a).localeCompare(displayName(b)) : a.cwd < b.cwd ? -1 : 1));
  return sessions;
}

/** Session name, or the first 8 characters of its id. */
export function displayName(s: LiveSession): string {
  return s.name || s.sessionId.slice(0, 8);
}

/** Profiles with at least one live session. */
export function busyProfiles(env: NodeJS.ProcessEnv = process.env, config?: Config): Set<string> {
  const out = new Set<string>();
  for (const s of liveSessions(env, config)) if (s.profile) out.add(s.profile);
  return out;
}

/**
 * Whether a profile has a live session. Besides the hub, a profile whose `sessions` folder
 * is still its own copy (not yet linked to the hub) is busy when a session in it is alive.
 */
export function profileBusy(name: string, env: NodeJS.ProcessEnv = process.env, config?: Config): boolean {
  if (busyProfiles(env, config).has(name)) return true;
  const own = join(profileDir(name, env), "sessions");
  try {
    if (!lstatSync(own).isDirectory()) return false;
  } catch {
    return false;
  }
  for (const s of readSessionFiles(own)) {
    const pid = typeof s.pid === "number" ? s.pid : Number.parseInt(text(s.pid), 10);
    if (pidAlive(pid)) return true;
  }
  // Session files are named <pid>.json; trust the name when the content is unreadable.
  try {
    return readdirSync(own).some((f) => /^\d+\.json$/.test(f) && pidAlive(Number(f.slice(0, -5))));
  } catch {
    return false;
  }
}

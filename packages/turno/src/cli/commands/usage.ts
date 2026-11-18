import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../core/config.js";
import { exhaustedUntil } from "../../core/exhausted.js";
import { isObject, readJsonFile } from "../../core/fsutil.js";
import { paths, profileDir, writePrivateFile } from "../../core/paths.js";
import { listProfiles } from "../../core/profiles.js";
import type { Command, Io } from "../io.js";
import { profileColor, style } from "../style.js";
import { isRecord, readState } from "../../core/state-file.js";

/** What `claude auth status --json` reports for a profile. */
export interface AuthStatus {
  loggedIn?: boolean;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  authMethod?: string;
}

/** Why `claude auth status` gave no answer, in a few words for the account column. */
function authFailure(err: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null, stdout: string, stderr: string): string {
  if (err?.code === "ENOENT") return "claude is not on PATH";
  if (err?.killed || err?.signal === "SIGTERM") return "claude auth status timed out";
  const line = (stderr || stdout).trim().split("\n")[0]?.trim();
  if (err && typeof err.code === "number") return `claude auth status exited with ${err.code}${line ? `: ${line.slice(0, 120)}` : ""}`;
  return "claude auth status gave no JSON";
}

/** Reuse an answer of `claude auth status` this long while the profile's login files stay the same (seconds). */
const AUTH_TTL = 300;

/**
 * The files a login or logout rewrites in a profile folder (the account in .claude.json, and
 * .credentials.json where there is no Keychain), as a key for the cached answer.
 */
function authFingerprint(dir: string): string {
  return [".claude.json", ".credentials.json"]
    .map((f) => {
      try {
        const st = statSync(join(dir, f));
        return `${st.ino}:${st.size}:${st.mtimeMs}`;
      } catch {
        return "-";
      }
    })
    .join("|");
}

function recordPlan(profile: string, s: AuthStatus, env: NodeJS.ProcessEnv): void {
  if (!s.loggedIn || !s.subscriptionType) return;
  try {
    writePrivateFile(join(paths(env).planDir, profile), `${s.subscriptionType}\n`, env);
  } catch {
    // the plan file is a cache for the status line
  }
}

/**
 * Run `claude auth status --json` with the profile's config dir (20 s timeout). Records the
 * plan in the state plan dir, where the status line reads it. On failure `why` says what went
 * wrong (claude missing, a timeout, an error line), so callers never show a bare "?".
 *
 * An answer is kept for AUTH_TTL seconds in the state cache, keyed by the profile's login files,
 * so `turno`, `turno status` and `turno profile list` do not start one claude per profile on
 * every run; logging in or out changes those files and asks again. Failures are not kept.
 */
function authStatusResult(profile: string, env: NodeJS.ProcessEnv = process.env): Promise<{ status?: AuthStatus; why?: string }> {
  const dir = profileDir(profile, env);
  const cacheFile = join(paths(env).state, "cache", `auth-${profile}.json`);
  const now = Date.now() / 1000;
  const cached = readJsonFile(cacheFile);
  if (
    isObject(cached) &&
    isObject(cached.status) &&
    cached.key === authFingerprint(dir) &&
    typeof cached.at === "number" &&
    now >= cached.at &&
    now - cached.at < AUTH_TTL
  ) {
    const s = cached.status as AuthStatus;
    recordPlan(profile, s, env);
    return Promise.resolve({ status: s });
  }
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["auth", "status", "--json"],
      { env: { ...env, CLAUDE_CONFIG_DIR: dir }, timeout: 20_000, encoding: "utf8" },
      (err, stdout, stderr) => {
        let s: AuthStatus;
        try {
          s = JSON.parse(stdout) as AuthStatus;
        } catch {
          resolve({ why: authFailure(err, stdout ?? "", stderr ?? "") });
          return;
        }
        if (!s || typeof s !== "object") {
          resolve({ why: authFailure(err, stdout ?? "", stderr ?? "") });
          return;
        }
        recordPlan(profile, s, env);
        try {
          // Keyed after the call, so a claude that touches its own files still finds the entry.
          writePrivateFile(cacheFile, JSON.stringify({ key: authFingerprint(dir), at: Math.trunc(now), status: s }), env);
        } catch {
          // without the cache the next run asks claude again
        }
        resolve({ status: s });
      },
    );
  });
}

/** `claude auth status --json` of a profile, or undefined when it fails (authStatusResult says why). */
export async function authStatus(profile: string, env: NodeJS.ProcessEnv = process.env): Promise<AuthStatus | undefined> {
  return (await authStatusResult(profile, env)).status;
}

interface Window {
  used_percentage?: number;
  resets_at?: number;
}

export interface UsageSnapshot {
  rate_limits?: { five_hour?: Window; seven_day?: Window };
  updated_at?: number;
}

/** The status line's usage snapshot: its windows are read field by field, so the shape check is light. */
const isSnapshot = (v: unknown): v is UsageSnapshot => isRecord(v) && (v.rate_limits === undefined || isRecord(v.rate_limits));

function readSnapshot(file: string): UsageSnapshot | undefined {
  return readState(file, isSnapshot);
}

/** The newer of the snapshot in the state dir and the one the bash tool's status line wrote. */
export function usageSnapshot(profile: string, env: NodeJS.ProcessEnv = process.env): UsageSnapshot {
  const p = paths(env);
  const current = readSnapshot(join(p.usageDir, `${profile}.json`));
  const legacy = readSnapshot(join(p.legacyConfig, "uso", `${profile}.json`));
  if (!current) return legacy ?? {};
  if (!legacy) return current;
  return (legacy.updated_at ?? -Infinity) > (current.updated_at ?? -Infinity) ? legacy : current;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/** "Thu 12 14:30" in local time. */
export function shortTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${DAYS[d.getDay()]} ${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function resetText(ts: number, now = Date.now() / 1000): string {
  const d = Math.floor(ts - now);
  if (d <= 0) return "already reset";
  const h = Math.floor(d / 3600);
  const m = Math.floor((d % 3600) / 60);
  const rel = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h${pad2(m)}m` : `${m}m`;
  return `resets in ${rel} (${shortTime(ts)})`;
}

function agoText(ts: number, now = Date.now() / 1000): string {
  const d = Math.floor(now - ts);
  if (d < 60) return "seconds ago";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}

export interface Account {
  email: string;
  plan: string;
  /** Why the account is unknown (claude missing, a timeout, an error), when it is. */
  why?: string;
}

export async function account(profile: string, env: NodeJS.ProcessEnv): Promise<Account> {
  const { status: s, why } = await authStatusResult(profile, env);
  if (!s) return { email: "?", plan: "", why: why ?? "claude auth status failed" };
  if (!s.loggedIn) return { email: "not logged in", plan: "" };
  return { email: s.email || "?", plan: s.subscriptionType || s.authMethod || "?" };
}

/** Cells of the usage bars. */
const BAR_CELLS = 20;

/**
 * The usage screen of `turno limit show`: each profile as its pill with the account, then a bar
 * per window with its reset time, the exhausted mark and how old the data is. The same layout
 * comes out as plain text in a pipe. `colors` holds the profiles of config.toml, for the pills.
 */
export function renderUsage(
  profiles: string[],
  accounts: Record<string, Account>,
  io: Io,
  opts: { colors?: Record<string, { color?: string | number }>; now?: number } = {},
): string {
  const now = opts.now ?? Date.now() / 1000;
  const s = style(io);
  const out: string[] = [];
  for (const p of profiles) {
    const { email, plan, why } = accounts[p] ?? { email: "?", plan: "" };
    const pill = s.profile(p, opts.colors ? profileColor(opts.colors, p) : undefined);
    const who = why
      ? `${s.warn("account unknown")}${s.muted(` (${why})`)}`
      : email === "not logged in"
        ? s.warn(email)
        : `${email}${plan ? s.muted(` · ${plan}`) : ""}`;
    out.push(s.wrap(`${pill}  `, who));
    const data = usageSnapshot(p, io.env);
    const limits = data.rate_limits ?? {};
    const hasLimits = Object.keys(limits).length > 0;
    for (const [key, label] of [
      ["five_hour", "5 hours"],
      ["seven_day", "week"],
    ] as const) {
      const w = limits[key];
      if (!w) continue;
      let pct = Number(w.used_percentage) || 0;
      const reset = typeof w.resets_at === "number" ? w.resets_at : undefined;
      if (reset && reset < now) pct = 0;
      const when = reset ? resetText(reset, now) : "";
      out.push(s.wrap(`  ${s.muted(label.padEnd(7))}  ${s.bar(pct, BAR_CELLS)}  `, pct >= 100 ? s.err(`used up, ${when}`) : s.muted(when)).trimEnd());
    }
    const exhausted = exhaustedUntil(p, io.env);
    if (exhausted !== undefined && exhausted > now) {
      out.push(s.note("err", `${s.err(`exhausted until ${shortTime(exhausted)}`)}${s.muted(": its projects open with the fallback, if one is set")}`));
    }
    if (!hasLimits) {
      const why =
        plan === "team" ? "the Team plan does not report these limits" : "shows up once a session of this account gets a response";
      out.push(s.muted(`  no usage data yet: ${why}`));
    }
    if (hasLimits && typeof data.updated_at === "number") out.push(s.muted(`  data from ${agoText(data.updated_at, now)}`));
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

export const command: Command = {
  summary: "5 h and weekly usage of each account, as bars",
  usage: [
    "Usage: turno usage [--watch]",
    "",
    "Shows the rate limits the status line records for each profile. --watch redraws",
    "every 30 s until Ctrl+C.",
  ].join("\n"),
  async run(args, io) {
    const watch = args.includes("--watch");
    const config = loadConfig(io.env);
    const profiles = listProfiles(config, io.env, "claude");
    const list = await Promise.all(profiles.map((p) => account(p, io.env)));
    const accounts = Object.fromEntries(profiles.map((p, i) => [p, list[i]!]));
    if (!watch) {
      io.out(renderUsage(profiles, accounts, io, { colors: config.profiles }).trimEnd());
      return 0;
    }
    return new Promise<number>((resolve) => {
      const draw = () => {
        io.out(`\x1b[2J\x1b[H${renderUsage(profiles, accounts, io, { colors: config.profiles })}\n${style(io).muted("refreshes every 30 s · Ctrl+C to quit")}`);
      };
      draw();
      const timer = setInterval(draw, 30_000);
      process.once("SIGINT", () => {
        clearInterval(timer);
        resolve(0);
      });
    });
  },
};

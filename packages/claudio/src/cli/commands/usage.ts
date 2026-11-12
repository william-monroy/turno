import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../core/config.js";
import { exhaustedUntil } from "../../core/exhausted.js";
import { paths, profileDir } from "../../core/paths.js";
import { listProfiles } from "../../core/profiles.js";
import { type Command, type Io, paint } from "../io.js";

/** What `claude auth status --json` reports for a profile. */
export interface AuthStatus {
  loggedIn?: boolean;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  authMethod?: string;
}

/**
 * Run `claude auth status --json` with the profile's config dir (20 s timeout). Records the
 * plan in the state plan dir, where the status line reads it. Undefined when it fails.
 */
export function authStatus(profile: string, env: NodeJS.ProcessEnv = process.env): Promise<AuthStatus | undefined> {
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["auth", "status", "--json"],
      { env: { ...env, CLAUDE_CONFIG_DIR: profileDir(profile, env) }, timeout: 20_000, encoding: "utf8" },
      (_err, stdout) => {
        let s: AuthStatus;
        try {
          s = JSON.parse(stdout) as AuthStatus;
        } catch {
          resolve(undefined);
          return;
        }
        if (!s || typeof s !== "object") {
          resolve(undefined);
          return;
        }
        if (s.loggedIn && s.subscriptionType) {
          try {
            const dir = paths(env).planDir;
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, profile), `${s.subscriptionType}\n`);
          } catch {
            // the plan file is a cache for the status line
          }
        }
        resolve(s);
      },
    );
  });
}

interface Window {
  used_percentage?: number;
  resets_at?: number;
}

export interface UsageSnapshot {
  rate_limits?: { five_hour?: Window; seven_day?: Window };
  updated_at?: number;
}

function readSnapshot(file: string): UsageSnapshot | undefined {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" ? (v as UsageSnapshot) : undefined;
  } catch {
    return undefined;
  }
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

export function bar(pct: number, width = 30): string {
  const filled = Math.round((Math.min(Math.max(pct, 0), 100) * width) / 100);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function resetText(ts: number, now = Date.now() / 1000): string {
  const d = Math.floor(ts - now);
  if (d <= 0) return "already reset";
  const h = Math.floor(d / 3600);
  const m = Math.floor((d % 3600) / 60);
  const rel = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h${pad2(m)}m` : `${m}m`;
  return `resets in ${rel} (${shortTime(ts)})`;
}

export function agoText(ts: number, now = Date.now() / 1000): string {
  const d = Math.floor(now - ts);
  if (d < 60) return "seconds ago";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}

export interface Account {
  email: string;
  plan: string;
}

export async function account(profile: string, env: NodeJS.ProcessEnv): Promise<Account> {
  const s = await authStatus(profile, env);
  if (!s) return { email: "?", plan: "?" };
  if (!s.loggedIn) return { email: "not logged in", plan: "" };
  return { email: s.email || "?", plan: s.subscriptionType || s.authMethod || "?" };
}

export function renderUsage(profiles: string[], accounts: Record<string, Account>, io: Io): string {
  const now = Date.now() / 1000;
  const out: string[] = [];
  for (const p of profiles) {
    const { email, plan } = accounts[p] ?? { email: "?", plan: "?" };
    out.push(paint(io, `${p}  ${email}${plan ? ` · ${plan}` : ""}`, "1"));
    const exhausted = exhaustedUntil(p, io.env);
    if (exhausted !== undefined && exhausted > now) {
      out.push(paint(io, `  marked exhausted: its projects use the fallback until ${shortTime(exhausted)}`, "2"));
    }
    const data = usageSnapshot(p, io.env);
    const limits = data.rate_limits ?? {};
    const hasLimits = Object.keys(limits).length > 0;
    if (!hasLimits) {
      const why =
        plan === "team" ? "the Team plan does not report these limits" : "shows up once a session of this account gets a response";
      out.push(paint(io, `  no data yet: ${why}`, "2"));
    }
    for (const [key, label] of [
      ["five_hour", "5 hours"],
      ["seven_day", "week"],
    ] as const) {
      const w = limits[key];
      if (!w) continue;
      let pct = Number(w.used_percentage) || 0;
      const reset = typeof w.resets_at === "number" ? w.resets_at : undefined;
      if (reset && reset < now) pct = 0;
      const code = pct < 50 ? "32" : pct < 80 ? "33" : "31";
      out.push(`  ${label.padEnd(8)}${paint(io, bar(pct), code)} ${pct.toFixed(0).padStart(3)}%  ${reset ? resetText(reset, now) : ""}`);
    }
    if (hasLimits && typeof data.updated_at === "number") out.push(paint(io, `  data from ${agoText(data.updated_at, now)}`, "2"));
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

export const command: Command = {
  summary: "5 h and weekly usage of each account, as bars",
  usage: [
    "Usage: claudio usage [--watch]",
    "",
    "Shows the rate limits the status line records for each profile. --watch redraws",
    "every 30 s until Ctrl+C.",
  ].join("\n"),
  async run(args, io) {
    const watch = args.includes("--watch");
    const profiles = listProfiles(loadConfig(io.env), io.env);
    const list = await Promise.all(profiles.map((p) => account(p, io.env)));
    const accounts = Object.fromEntries(profiles.map((p, i) => [p, list[i]!]));
    if (!watch) {
      io.out(renderUsage(profiles, accounts, io).trimEnd());
      return 0;
    }
    return new Promise<number>((resolve) => {
      const draw = () => {
        io.out(`\x1b[2J\x1b[H${renderUsage(profiles, accounts, io)}\n(refreshes every 30 s · Ctrl+C to quit)`);
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

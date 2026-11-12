import { loadConfig } from "../../core/config.js";
import { clearExhausted, exhaustedUntil, markExhausted } from "../../core/exhausted.js";
import { listProfiles } from "../../core/profiles.js";
import { formatUntil } from "../../core/resolve.js";
import { DRY_RUN, JSON_FLAG, WATCH, bool, parseFlags, printJson, str } from "../args.js";
import { group } from "../group.js";
import { type Io, fail } from "../io.js";
import { launcherPath } from "../launch.js";
import { parseLocalDateTime } from "./exhausted.js";
import { command as usage, account, usageSnapshot } from "./usage.js";

/** "5h", "90m", "2h30m" to seconds. */
export function parseDuration(text: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim());
  if (!m || (!m[1] && !m[2])) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60;
}

/** Usage of every profile as data, for --json and claudio status. */
export async function limitsData(env: NodeJS.ProcessEnv, withAccounts = true) {
  const profiles = listProfiles(loadConfig(env), env);
  const accounts = withAccounts ? await Promise.all(profiles.map((p) => account(p, env))) : [];
  return profiles.map((p, i) => {
    const snap = usageSnapshot(p, env);
    const limits = snap.rate_limits ?? {};
    const win = (w?: { used_percentage?: number; resets_at?: number }) =>
      w ? { used: Number(w.used_percentage) || 0, resetsAt: typeof w.resets_at === "number" ? w.resets_at : null } : null;
    return {
      profile: p,
      ...(withAccounts ? { email: accounts[i]!.email, plan: accounts[i]!.plan } : {}),
      exhaustedUntil: exhaustedUntil(p, env) ?? null,
      fiveHour: win(limits.five_hour),
      week: win(limits.seven_day),
      updatedAt: snap.updated_at ?? null,
    };
  });
}

async function show(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, { ...JSON_FLAG, ...WATCH }, 0);
  if (bool(p, "json")) {
    if (bool(p, "watch")) fail("--json and --watch do not go together");
    printJson(io.out, await limitsData(io.env));
    return 0;
  }
  return usage.run(bool(p, "watch") ? ["--watch"] : [], io);
}

function profileArg(name: string | undefined, io: Io, verb: string): string {
  if (!name) return fail(`usage: claudio limit ${verb} <profile>`);
  if (!launcherPath(name, io.env)) fail(`no profile '${name}' (claudio profile list shows them)`);
  return name;
}

async function set(args: string[], io: Io): Promise<number> {
  // The bash form `exhausted <profile> until "YYYY-MM-DD HH:MM"` still works.
  const legacy = args[1] === "until" || args[1] === "hasta";
  const p = parseFlags(legacy ? [args[0]!, "--until", ...args.slice(2)] : args, { until: { type: "string" }, for: { type: "string" }, ...DRY_RUN }, 1);
  const name = profileArg(p.positionals[0], io, "set");
  const untilText = str(p, "until");
  const forText = str(p, "for");
  if (untilText && forText) fail("use --until or --for, not both");
  let until = Math.floor(Date.now() / 1000) + 5 * 3600;
  if (untilText) {
    const t = parseLocalDateTime(untilText);
    if (t === undefined) fail(`invalid date: ${untilText} (format YYYY-MM-DD HH:MM)`);
    until = t;
  } else if (forText) {
    const d = parseDuration(forText);
    if (d === undefined) fail(`invalid duration: ${forText} (like 5h, 90m or 2h30m)`);
    until = Math.floor(Date.now() / 1000) + d;
  }
  if (!bool(p, "dry-run")) markExhausted(name, until, io.env);
  io.out(`${name} exhausted until ${formatUntil(until)}; its projects open with the fallback${bool(p, "dry-run") ? " (dry run)" : ""}`);
  return 0;
}

async function clear(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, DRY_RUN, 1);
  const name = profileArg(p.positionals[0], io, "clear");
  if (!bool(p, "dry-run")) clearExhausted(name, io.env);
  io.out(`${name} available again${bool(p, "dry-run") ? " (dry run)" : ""}`);
  return 0;
}

export const command = group(
  "limit",
  "usage limits of each account, and the exhausted marks that move projects to the fallback",
  {
    show: { summary: "5 h and weekly usage of each account, as bars", synopsis: "[--watch] [--json]", flags: ["--watch", "--json"], run: show },
    set: {
      summary: "mark a profile exhausted (default for 5 h); its projects open with the fallback",
      synopsis: '<profile> [--until "YYYY-MM-DD HH:MM" | --for 2h] [--dry-run]',
      args: ["profile"],
      flags: ["--until", "--for", "--dry-run"],
      run: set,
    },
    clear: { summary: "clear a profile's exhausted mark", synopsis: "<profile> [--dry-run]", args: ["profile"], flags: ["--dry-run"], run: clear },
  },
  { fallback: "show" },
);

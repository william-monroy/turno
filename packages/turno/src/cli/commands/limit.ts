import { adapter } from "../../agents/index.js";
import { loadConfig } from "../../core/config.js";
import { clearExhausted, exhaustedUntil, markExhausted } from "../../core/exhausted.js";
import { agentOf, listProfiles } from "../../core/profiles.js";
import { formatUntil } from "../../core/resolve.js";
import { DRY_RUN, JSON_FLAG, WATCH, bool, flagsOf, parseFlags, str } from "../args.js";
import { group } from "../group.js";
import { type Io, fail } from "../io.js";
import { emit, emitLines, jsonOutput } from "../output.js";
import { launcherPath } from "../launch.js";
import { parseLocalDateTime } from "./exhausted.js";
import { command as usage, account, usageSnapshot } from "./usage.js";

/** "5h", "90m", "2h30m" to seconds. */
export function parseDuration(text: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim());
  if (!m || (!m[1] && !m[2])) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60;
}

/** Usage of every profile as data, for --json and turno status. */
export async function limitsData(env: NodeJS.ProcessEnv, withAccounts = true) {
  const config = loadConfig(env);
  const profiles = listProfiles(config, env);
  // Usage windows and accounts come from Claude Code; other agents show only exhausted marks.
  const accounts = withAccounts
    ? await Promise.all(profiles.map((p) => (adapter(agentOf(p, config)).accountDetails ? account(p, env) : undefined)))
    : [];
  return profiles.map((p, i) => {
    const snap = usageSnapshot(p, env);
    const limits = snap.rate_limits ?? {};
    const win = (w?: { used_percentage?: number; resets_at?: number }) =>
      w
        ? { used: Number(w.used_percentage) || 0, resetsAt: typeof w.resets_at === "number" ? w.resets_at : null }
        : null;
    return {
      profile: p,
      agent: agentOf(p, config),
      ...(withAccounts ? { email: accounts[i]?.email ?? null, plan: accounts[i]?.plan ?? null } : {}),
      exhaustedUntil: exhaustedUntil(p, env) ?? null,
      fiveHour: win(limits.five_hour),
      week: win(limits.seven_day),
      updatedAt: snap.updated_at ?? null,
    };
  });
}

const SHOW_SPEC = { ...JSON_FLAG, ...WATCH };

/** `turno limit show --json`: one element per profile. */
const SHOW_JSON = jsonOutput(["profile", "agent", "email", "plan", "exhaustedUntil", "fiveHour", "week", "updatedAt"]);

/** How often `limit show --watch --json` prints the profiles again. */
const WATCH_EVERY_MS = 30_000;

async function show(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, SHOW_SPEC, 0);
  if (bool(p, "json")) {
    if (bool(p, "watch")) return watchJson(io, p);
    emit(io, p, SHOW_JSON, await limitsData(io.env));
    return 0;
  }
  const config = loadConfig(io.env);
  if (!listProfiles(config, io.env).length) {
    io.out("No profiles yet (turno profile add <name>).");
    return 0;
  }
  if (!listProfiles(config, io.env, "claude").length) {
    io.out("Usage limits come from Claude Code profiles, and there are none yet (turno profile add <name>).");
    return 0;
  }
  return usage.run(bool(p, "watch") ? ["--watch"] : [], io);
}

/**
 * `--watch --json`: every profile as one JSON line (NDJSON) now and every 30 s, until Ctrl-C or
 * `signal`. A reader tells the rounds apart by `updatedAt` or by the profile coming back.
 */
export async function watchJson(
  io: Io,
  p: Parameters<typeof emit>[1],
  signal?: AbortSignal,
  everyMs = WATCH_EVERY_MS,
): Promise<number> {
  const stop = signal ?? interrupted();
  while (!stop.aborted) {
    emitLines(io, p, SHOW_JSON, await limitsData(io.env));
    await new Promise<void>((r) => {
      const timer = setTimeout(r, everyMs);
      stop.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          r();
        },
        { once: true },
      );
    });
  }
  return 0;
}

/** An abort signal for Ctrl-C. */
function interrupted(): AbortSignal {
  const c = new AbortController();
  process.once("SIGINT", () => c.abort());
  return c.signal;
}

async function profileArg(given: string | undefined, io: Io, verb: "set" | "clear"): Promise<string> {
  const name =
    given ??
    (await (
      await import("../picker.js")
    ).pickProfile(io, {
      command: `limit ${verb}`,
      title: verb === "set" ? "Profile to mark exhausted" : "Profile to clear",
    }));
  if (!launcherPath(name, io.env)) fail(`no profile '${name}' (turno profile list shows them)`);
  return name;
}

const SET_SPEC = { until: { type: "string" }, for: { type: "string" }, ...DRY_RUN } as const;

async function set(args: string[], io: Io): Promise<number> {
  // The bash form `exhausted <profile> until "YYYY-MM-DD HH:MM"` still works.
  const legacy = args[1] === "until" || args[1] === "hasta";
  const p = parseFlags(legacy ? [args[0]!, "--until", ...args.slice(2)] : args, SET_SPEC, 1);
  const name = await profileArg(p.positionals[0], io, "set");
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
  io.out(
    `${name} exhausted until ${formatUntil(until)}; its projects open with the fallback, if one is set${bool(p, "dry-run") ? " (dry run)" : ""}`,
  );
  return 0;
}

async function clear(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, DRY_RUN, 1);
  const name = await profileArg(p.positionals[0], io, "clear");
  if (!bool(p, "dry-run")) clearExhausted(name, io.env);
  io.out(`${name} available again${bool(p, "dry-run") ? " (dry run)" : ""}`);
  return 0;
}

export const command = group(
  "limit",
  "usage limits of each account, and the exhausted marks that move projects to the fallback",
  {
    show: {
      summary: "5 h and weekly usage of each account, as bars",
      synopsis: "[--watch] [--json]",
      flags: flagsOf(SHOW_SPEC),
      json: SHOW_JSON,
      run: show,
    },
    set: {
      summary: "mark a profile exhausted (default for 5 h); its projects open with the fallback, if one is set",
      synopsis: '<profile> [--until "YYYY-MM-DD HH:MM" | --for 2h] [--dry-run]',
      args: ["profile"],
      flags: flagsOf(SET_SPEC),
      run: set,
    },
    clear: {
      summary: "clear a profile's exhausted mark",
      synopsis: "<profile> [--dry-run]",
      args: ["profile"],
      flags: flagsOf(DRY_RUN),
      run: clear,
    },
  },
  {
    fallback: "show",
    examples: [
      "turno limit show",
      "turno limit show --watch --json  # one JSON line per profile, every 30 s",
      "turno limit set work --for 2h",
      "turno limit clear work",
    ],
  },
);

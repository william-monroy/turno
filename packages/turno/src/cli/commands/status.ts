import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadManifest } from "../../core/manifest.js";
import { migrationPending } from "../../core/config-edit.js";
import { loadConfig } from "../../core/config.js";
import { paths, tildify } from "../../core/paths.js";
import { availableUpdate } from "../../core/update.js";
import { packageInfo } from "../../core/version.js";
import { FALLBACK, checkFonts, userFontDir } from "../../ui/fonts.js";
import { currentStatusLine, isTurnoStatusLine } from "../../ui/settings.js";
import { currentTerminal, nerdHere } from "../../ui/terminal-id.js";
import { JSON_FLAG, bool, parseFlags, printJson } from "../args.js";
import { type Command, type Io, plural } from "../io.js";
import { type Style, profileColor, style, visibleWidth } from "../style.js";
import { mcpdStatus } from "./doctor.js";
import { DEFAULT_AGENT, adapter } from "../../agents/index.js";
import { limitsData } from "./limit.js";
import { profilesData, resolveAll, usingText } from "./profile.js";
import { sessionsData } from "./session.js";
import { shortTime } from "./usage.js";

/** The one thing to do next, if any: what `turno` and `turno status` end with. */
export interface NextStep {
  command: string;
  why: string;
}

/** Servers in mcp.toml, or 0 when it is missing or unreadable (turno mcp list shows why). */
function manifestServers(env: NodeJS.ProcessEnv): number {
  if (!existsSync(paths(env).mcpFile)) return 0;
  try {
    return Object.keys(loadManifest(env).servers).length;
  } catch {
    return 0;
  }
}

/** Profiles whose agent config does not point at the gateway yet, from a silent `mcp sync --dry-run`. */
async function syncPending(env: NodeJS.ProcessEnv): Promise<number> {
  try {
    const { syncProfiles } = await import("./mcp.js");
    const quiet: Io = { env, isTty: false, out: () => {}, err: () => {} };
    return (await syncProfiles(quiet, { dryRun: true })).changed;
  } catch {
    return 0;
  }
}

type StatusBase = Awaited<ReturnType<typeof statusBase>>;

/** First thing that keeps this machine from working fully, in the order a person would fix it. */
async function nextStep(env: NodeJS.ProcessEnv, d: StatusBase): Promise<NextStep | null> {
  if (d.migrationPending) return { command: "turno migrate", why: "the bash claudio config is not moved to turno yet" };
  if (!d.profiles.length) return { command: "turno init", why: "no profiles yet; init finds your agents, folders and MCP servers" };
  const notSetUp = d.profiles.find((x) => !x.setUp);
  if (notSetUp) return { command: `turno profile repair ${notSetUp.name}`, why: `profile ${notSetUp.name} has no folder or launcher yet` };
  const servers = manifestServers(env);
  if (servers && !d.mcpd.running) return { command: "turno mcp daemon start", why: `mcp.toml has ${plural(servers, "server")} and the gateway is not running` };
  if (servers) {
    const pending = await syncPending(env);
    if (pending) return { command: "turno mcp sync", why: `${plural(pending, "agent config")} do not point at the gateway yet` };
  }
  if (d.update) return { command: "turno upgrade", why: `turno ${d.update} is available` };
  if (d.look.statusLine !== "turno") return { command: "turno ui install", why: "optional: the status line with account, usage and gateway" };
  return null;
}

/** Everything `turno status` shows, as data. */
export async function statusData(env: NodeJS.ProcessEnv, cwd = process.cwd()) {
  const base = await statusBase(env, cwd);
  return { ...base, next: await nextStep(env, base) };
}

async function statusBase(env: NodeJS.ProcessEnv, cwd: string) {
  const config = loadConfig(env);
  const [profiles, limits, mcpd] = await Promise.all([profilesData(env, config), limitsData(env, false), mcpdStatus(env, config)]);
  const all = resolveAll(cwd, config, env);
  const here = all[0]!.r;
  const sessions = sessionsData(env);
  const line = currentStatusLine(join(paths(env).hub, "settings.json"));
  const fontDir = userFontDir(env);
  const fonts = fontDir ? checkFonts(FALLBACK, fontDir) : [];
  const terminal = currentTerminal(env);
  // Why mcpd is down: the last start error (mcpd.error.json) and who holds its port.
  const mcpdProblems = mcpd.running ? [] : await (await import("./mcpd.js")).downReasons(env).catch(() => []);
  return {
    version: packageInfo().version,
    update: availableUpdate(env) ?? null,
    migrationPending: migrationPending(env),
    here: {
      dir: tildify(cwd, env),
      assigned: here.assigned || null,
      chosen: here.chosen || null,
      reason: here.reason,
      note: here.note || null,
      agents: Object.fromEntries(all.map(({ agent, r }) => [agent, { chosen: r.chosen || null, text: usingText(agent, r, env) }])),
    },
    profiles: profiles.map((p) => {
      const l = limits.find((x) => x.profile === p.name);
      return { ...p, fiveHour: l?.fiveHour ?? null, week: l?.week ?? null };
    }),
    sessions: {
      total: sessions.length,
      byProfile: sessions.reduce<Record<string, number>>((acc, s) => {
        const key = s.profile ?? (s.source === "desktop" ? "desktop" : "unknown");
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    },
    mcpd: { running: mcpd.running, port: mcpd.port, problems: mcpdProblems },
    look: {
      statusLine: isTurnoStatusLine(line) ? "turno" : (line?.command ?? null),
      font: fonts.length > 0 && fonts.every((f) => f.state === "installed"),
      terminal: terminal ?? null,
      icons: config.icons === "auto" ? (nerdHere(env, config.nerdTerminals) ? "nerd" : "unicode") : config.icons,
    },
  };
}

/** "33m", "2h06m", "5d 18h": time left until a window resets. */
export function resetIn(resetsAt: number | null, now: number): string {
  if (!resetsAt || resetsAt <= now) return "";
  const d = Math.floor(resetsAt - now);
  const h = Math.floor(d / 3600);
  const m = Math.floor((d % 3600) / 60);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

type StatusData = Awaited<ReturnType<typeof statusData>>;

/** The status screen as lines: the same layout with colors on a terminal and as plain text. */
export function renderStatus(d: StatusData, io: Io, opts: { now?: number; colors?: Record<string, { color?: string | number }> } = {}): string[] {
  const now = opts.now ?? Date.now() / 1000;
  const s = style(io, { nerd: d.look.icons === "nerd" });
  const pill = (name: string) => s.profile(name, opts.colors ? profileColor(opts.colors, name) : undefined);
  const out: string[] = [];
  const using = d.here.chosen ? pill(d.here.chosen) : "plain claude";
  out.push(s.wrap(`${s.bold(s.accent("turno"))} ${s.muted(d.version)}  `, `${d.here.dir} ${s.icon("arrow")} ${using}`));
  if (d.update) out.push(s.warn(`${s.icon("info")} turno ${d.update} is available: turno upgrade`));
  if (d.migrationPending) out.push(s.warn(`${s.icon("warn")} the bash claudio config is not migrated yet: turno migrate`));

  // Here: what each agent opens in this folder.
  out.push("", s.header("Here"));
  const why = d.here.note ? `${d.here.assigned} ${d.here.note}` : d.here.reason;
  const here: string[][] = [[s.muted(DEFAULT_AGENT), d.here.chosen ? pill(d.here.chosen) : "plain claude", s.muted(why)]];
  for (const [agent, a] of Object.entries(d.here.agents)) {
    if (agent === DEFAULT_AGENT) continue;
    const m = /^(.*) \((.*)\)$/.exec(a.text);
    here.push([s.muted(agent), a.chosen ? pill(a.chosen) : (m?.[1] ?? a.text), s.muted(m?.[2] ?? "")]);
  }
  out.push(...s.table(here, { columns: [{}, {}, { drop: 1 }] }));

  // Profiles: usage of each account with its reset time, and who it is.
  out.push("", s.header("Profiles"));
  if (!d.profiles.length) out.push(`  none yet ${s.muted("(turno profile add <name>)")}`);
  else {
    const win = (w: { used: number; resetsAt: number | null } | null) => {
      if (!w) return [s.muted("-"), ""];
      const used = w.resetsAt && w.resetsAt < now ? 0 : w.used;
      return [s.bar(used, 8), s.muted(resetIn(w.resetsAt, now))];
    };
    const rows: string[][] = [["", s.muted("5 hours"), "", s.muted("week"), "", s.muted("account")]];
    for (const x of d.profiles) {
      const who = !x.setUp ? s.warn("not set up") : !adapter(x.agent).accountDetails ? adapter(x.agent).label : x.email ? x.email : s.warn("not logged in");
      const flags = [...x.roles, x.exhaustedUntil ? `exhausted until ${shortTime(x.exhaustedUntil)}` : ""].filter(Boolean).join(", ");
      const usage = adapter(x.agent).accountDetails ? [...win(x.fiveHour), ...win(x.week)] : [s.muted("-"), "", s.muted("-"), ""];
      rows.push([pill(x.name), ...usage, `${who}${x.plan ? s.muted(` · ${x.plan}`) : ""}${flags ? s.muted(`  ${flags}`) : ""}`]);
    }
    out.push(...s.table(rows, { columns: [{}, {}, { drop: 3 }, {}, { drop: 4 }, {}] }));
  }

  // The machine: gateway, sessions and the look.
  out.push("", s.header("Machine"));
  const by = Object.entries(d.sessions.byProfile)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const gateway = d.mcpd.running
    ? `${s.lead("on", "running")} ${s.muted(`on port ${d.mcpd.port}`)}`
    : `${s.lead("off", s.warn("not running"))} ${s.muted("(turno mcp daemon start)")}`;
  const lineText = d.look.statusLine === "turno" ? "turno status line" : d.look.statusLine ? `status line \`${d.look.statusLine}\`` : "no status line";
  const look = [lineText, d.look.font ? "font installed" : `font missing ${s.muted("(turno ui install)")}`, `${d.look.icons} icons here`].join(s.muted(" · "));
  out.push(s.kv("gateway", gateway, 8));
  for (const problem of d.mcpd.problems) out.push(s.wrap(`  ${" ".repeat(8)}  ${s.warn(s.icon("warn"))} `, s.warn(problem)));
  out.push(s.kv("sessions", `${plural(d.sessions.total, "live session")}${by ? s.muted(` (${by})`) : ""}`, 8));
  out.push(s.kv("look", look, 8));

  out.push("", ...nextLines(s, d.next));
  out.push("", s.muted("turno doctor checks each part; turno limit, session and profile show more."));
  return out;
}

function nextLines(s: Style, next: NextStep | null): string[] {
  const label = s.lead("next", s.bold(s.accent("Next")));
  if (!next) return [`${label}  ${s.ok("nothing to do: everything is set up")}`];
  const pad = " ".repeat(visibleWidth(label) + 2);
  return [s.wrap(`${label}  `, s.bold(next.command)), s.wrap(pad, s.muted(next.why))];
}

export const command: Command = {
  summary: "one screen with everything: this folder, profiles and usage, sessions, mcpd and the look",
  usage: "Usage: turno status [--json]\n\nturno doctor checks each part in depth and can fix problems.",
  flags: ["--json"],
  async run(args, io: Io) {
    const p = parseFlags(args, JSON_FLAG, 0);
    const d = await statusData(io.env);
    if (bool(p, "json")) {
      printJson(io, d);
      return 0;
    }
    let profiles: Record<string, { color?: string | number }> = {};
    try {
      profiles = loadConfig(io.env).profiles;
    } catch {
      /* statusData already read it */
    }
    for (const line of renderStatus(d, io, { colors: profiles })) io.out(line);
    return 0;
  },
};

/**
 * What bare `turno` shows: this screen once turno is set up, the help before that (so a new
 * person sees "Start here: turno init").
 */
export async function homeScreen(io: Io): Promise<number | undefined> {
  const p = paths(io.env);
  if (!existsSync(p.configFile) && !existsSync(p.mcpFile)) return undefined;
  const code = await command.run([], io);
  return code;
}

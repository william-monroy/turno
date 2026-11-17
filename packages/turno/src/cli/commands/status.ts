import { join } from "node:path";
import { migrationPending } from "../../core/config-edit.js";
import { loadConfig } from "../../core/config.js";
import { paths, tildify } from "../../core/paths.js";
import { availableUpdate } from "../../core/update.js";
import { packageInfo } from "../../core/version.js";
import { FALLBACK, checkFonts, userFontDir } from "../../ui/fonts.js";
import { currentStatusLine, isTurnoStatusLine } from "../../ui/settings.js";
import { currentTerminal, nerdHere } from "../../ui/terminal-id.js";
import { JSON_FLAG, bool, parseFlags, printJson } from "../args.js";
import { type Command, type Io, paint, plural } from "../io.js";
import { mcpdStatus } from "./doctor.js";
import { DEFAULT_AGENT, adapter } from "../../agents/index.js";
import { limitsData } from "./limit.js";
import { profilesData, resolveAll, usingText } from "./profile.js";
import { sessionsData } from "./session.js";
import { bar, shortTime } from "./usage.js";

/** Everything `turno status` shows, as data. */
export async function statusData(env: NodeJS.ProcessEnv, cwd = process.cwd()) {
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
        return { ...acc, [key]: (acc[key] ?? 0) + 1 };
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

function pct(w: { used: number; resetsAt: number | null } | null, now: number): string {
  if (!w) return `${"-".padStart(7)}${" ".repeat(6)}`;
  const used = w.resetsAt && w.resetsAt < now ? 0 : w.used;
  return `${bar(used, 8)} ${used.toFixed(0).padStart(3)}%`;
}

export const command: Command = {
  summary: "one screen with everything: this folder, profiles and usage, sessions, mcpd and the look",
  usage: "Usage: turno status [--json]\n\nturno doctor checks each part in depth and can fix problems.",
  flags: ["--json"],
  async run(args, io: Io) {
    const p = parseFlags(args, JSON_FLAG, 0);
    const d = await statusData(io.env);
    if (bool(p, "json")) {
      printJson(io.out, d);
      return 0;
    }
    const now = Date.now() / 1000;
    const dim = (s: string) => paint(io, s, "2");
    io.out(`${paint(io, `turno ${d.version}`, "1")}${d.update ? paint(io, `  (${d.update} available: turno upgrade)`, "33") : ""}`);
    if (d.migrationPending) io.out(paint(io, "the bash claudio config is not migrated yet: turno migrate", "33"));
    const using = d.here.chosen ?? "plain claude";
    io.out(`here      ${d.here.dir} -> ${using}${d.here.note ? ` (${d.here.assigned} ${d.here.note})` : dim(` (${d.here.reason})`)}`);
    for (const [agent, a] of Object.entries(d.here.agents)) if (agent !== DEFAULT_AGENT) io.out(`          ${agent} -> ${a.text}`);
    if (!d.profiles.length) io.out("profiles  none yet (turno profile add <name>)");
    const w = Math.max(0, ...d.profiles.map((x) => x.name.length));
    for (const [i, x] of d.profiles.entries()) {
      const who = !x.setUp ? "not set up" : !adapter(x.agent).accountDetails ? adapter(x.agent).label : (x.email ?? "not logged in");
      const flags = [...x.roles, x.exhaustedUntil ? `exhausted until ${shortTime(x.exhaustedUntil)}` : ""].filter(Boolean).join(", ");
      io.out(`${i === 0 ? "profiles  " : "          "}${x.name.padEnd(w)}  5h ${pct(x.fiveHour, now)}  week ${pct(x.week, now)}  ${who}${x.plan ? ` · ${x.plan}` : ""}${flags ? dim(`  ${flags}`) : ""}`);
    }
    const by = Object.entries(d.sessions.byProfile).map(([k, v]) => `${k} ${v}`).join(", ");
    io.out(`sessions  ${plural(d.sessions.total, "live session")}${by ? ` (${by})` : ""}`);
    io.out(`mcpd      ${d.mcpd.running ? `running on port ${d.mcpd.port}` : "not running (turno mcp daemon start)"}`);
    for (const problem of d.mcpd.problems) io.out(`          ${paint(io, problem, "33")}`);
    const lineText = d.look.statusLine === "turno" ? "turno status line" : d.look.statusLine ? `status line \`${d.look.statusLine}\`` : "no status line";
    io.out(`look      ${lineText}, ${d.look.font ? "font installed" : "font missing (turno ui install)"}, ${d.look.icons} icons here`);
    io.out(dim("\nturno doctor checks each part; turno limit, session and profile show more."));
    return 0;
  },
};

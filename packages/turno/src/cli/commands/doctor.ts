import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { loadRegistry } from "../../accounts/registry.js";
import { migrationPending } from "../../core/config-edit.js";
import { type Config, loadConfig } from "../../core/config.js";
import { type Manifest, effectiveLaunch, loadManifest, servesProfile } from "../../core/manifest.js";
import { paths, tildify } from "../../core/paths.js";
import { unsetVars } from "../../core/secrets.js";
import { AGENT_IDS, type AgentId, DEFAULT_AGENT, adapter, agentHub, agentProfileDir } from "../../agents/index.js";
import { agentOf, configFindings, listProfiles } from "../../core/profiles.js";
import { availableUpdate } from "../../core/update.js";
import { packageInfo } from "../../core/version.js";
import { FALLBACK, checkFonts, userFontDir } from "../../ui/fonts.js";
import { currentStatusLine, isTurnoStatusLine, statusLineLabel } from "../../ui/settings.js";
import { JSON_FLAG, type Parsed, bool, parseFlags } from "../args.js";
import { emit, jsonOutput } from "../output.js";
import { type Command, type Io, fail } from "../io.js";
import { findOnPath } from "../launch.js";
import { MARKER, isGenerated, launcherName, launcherText } from "../launchers.js";
import { duration, padEnd, profileColor, style, visibleWidth } from "../style.js";
import { nerdHere } from "../../ui/terminal-id.js";

/** `turno doctor --json`. */
const DOCTOR_JSON = jsonOutput(["ok", "counts", "ms", "next", "checks"]);

export type Level = "ok" | "warn" | "fail" | "info";

/** What a check found, as `--json` and the icons show it: an `info` check is a skip. */
type Status = "ok" | "warn" | "fail" | "skip";

export interface Fix {
  /** The command a person would run; equal labels run once. */
  label: string;
  run(io: Io): Promise<unknown> | unknown;
}

export interface Check {
  area: string;
  level: Level;
  text: string;
  /** A repair `turno doctor --fix` runs; its label is the command a person would type. */
  fix?: Fix;
  /** A command that fixes it, which a person runs (doctor --fix does not). */
  hint?: string;
  /** The manual step, when no single command fixes it. */
  manual?: string;
}

function statusOf(level: Level): Status {
  return level === "info" ? "skip" : level;
}

/** The command that fixes a check, whether `--fix` runs it or a person does. */
function fixCommand(c: Check): string | undefined {
  return c.fix?.label ?? c.hint;
}

/** Whether a check is a problem: a warning or a failure. */
const isProblem = (c: Check) => c.level === "warn" || c.level === "fail";

/** Whether a file is the original bash claudio script rather than this CLI. */
export function isLegacyScript(file: string): boolean {
  try {
    if (lstatSync(file).isSymbolicLink() && readlinkSync(file).endsWith(".js")) return false;
    const head = readFileSync(file, "utf8").slice(0, 400);
    return head.startsWith("#!/bin/bash") && head.includes("turno");
  } catch {
    return false;
  }
}

export async function mcpdStatus(
  env: NodeJS.ProcessEnv,
  config: Config | undefined,
): Promise<{ level: Level; text: string; running: boolean; port: number }> {
  const p = paths(env);
  let port = config?.mcpd.port ?? 47821;
  try {
    const n = Number.parseInt(readFileSync(p.mcpdPort, "utf8").trim(), 10);
    if (Number.isInteger(n) && n > 0) port = n;
  } catch {
    // no port file: the configured port
  }
  let token: string;
  try {
    token = readFileSync(p.mcpdToken, "utf8").trim();
  } catch {
    return {
      level: "info",
      running: false,
      port,
      text: `mcpd: no token at ${tildify(p.mcpdToken, env)} (not started yet: turno mcp daemon start)`,
    };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok)
      return { level: "warn", running: false, port, text: `mcpd on port ${port} answered HTTP ${res.status}` };
    return { level: "ok", running: true, port, text: `mcpd reachable on port ${port}` };
  } catch {
    return { level: "info", running: false, port, text: `mcpd not reachable on port ${port} (turno mcp daemon start)` };
  }
}

/** `turno mcp sync`, which plans every agent config first and rewrites only those that change. */
const syncFix: Fix = {
  label: "turno mcp sync",
  run: async (io) => (await import("./mcp.js")).command.run(["sync"], io),
};

/**
 * Variables mcp.toml reads from mcpd's environment (`env:NAME`, `${NAME}`) that are not set in
 * this one: in stdio servers' env and args (every profile variant), and in the headers and
 * OAuth client secret of remotes mcpd proxies. Names only, never a value.
 */
function envRefChecks(manifest: Manifest, env: NodeJS.ProcessEnv): Check[] {
  const out: Check[] = [];
  let refs = 0;
  for (const server of Object.values(manifest.servers)) {
    const unset = new Set<string>();
    const scan = (value: string, whole = true) => {
      if (value.includes("${") || (whole && value.startsWith("env:"))) refs++;
      for (const name of unsetVars(value, env, whole)) unset.add(name);
    };
    if (server.kind === "stdio") {
      if (server.builtin) continue;
      for (const variant of ["default", ...Object.keys(server.variants)]) {
        const launch = effectiveLaunch(server, variant);
        for (const v of Object.values(launch.env)) scan(v);
        for (const a of launch.args) scan(a, false);
      }
    } else if (server.proxy) {
      for (const v of Object.values(server.headers)) scan(v);
      if (server.oauth?.clientSecret) scan(server.oauth.clientSecret);
    }
    if (!unset.size) continue;
    const names = [...unset].sort();
    const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    out.push({
      area: "mcp",
      level: "warn",
      text: `${server.name} reads ${list} from mcpd's environment, and ${names.length === 1 ? "it is" : "they are"} not set here`,
      manual: `set ${list} where mcpd starts, then turno mcp daemon restart; or store ${names.length === 1 ? "it" : "each"} with turno secret set <name> and write keychain:<name> instead`,
    });
  }
  if (refs && !out.length)
    out.push({ area: "mcp", level: "ok", text: `mcp.toml: every environment reference is set here (${refs})` });
  return out;
}

const repair = (name: string): Fix => ({
  label: `turno profile repair ${name}`,
  run: async (io) => (await import("./setup.js")).setupProfiles([name], io),
});

function isLinkTo(path: string, target: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
  } catch {
    return false;
  }
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Launcher, folder, hub links and agent checks of one profile. */
function profileChecks(name: string, agent: AgentId, env: NodeJS.ProcessEnv): Check[] {
  const a = adapter(agent);
  const area = `profile ${name}`;
  const out: Check[] = [];
  const launcher = join(paths(env).bin, launcherName(name, agent));
  if (!existsSync(launcher))
    out.push({
      area,
      level: "fail",
      text: `profile ${name}: no launcher ${tildify(launcher, env)}`,
      fix: repair(name),
    });
  else if (!isGenerated(launcher)) {
    out.push({
      area,
      level: "fail",
      text: `profile ${name}: ${tildify(launcher, env)} was not generated by turno`,
      manual: `move ${tildify(launcher, env)} aside (it is yours, so turno does not overwrite it), then turno profile repair ${name}`,
    });
  } else {
    // Classic launchers vary with the turno that wrote them: only a bash claudio one is stale.
    const text = readFileSync(launcher, "utf8");
    const stale = a.classicLauncher
      ? !text.includes(MARKER) && "launcher from the bash claudio"
      : text !== launcherText(name, env, agent) && "launcher is out of date";
    if (stale) out.push({ area, level: "warn", text: `profile ${name}: ${stale}`, fix: repair(name) });
    else
      out.push({
        area,
        level: "ok",
        text: `profile ${name}: ${agent === DEFAULT_AGENT ? "" : `${a.label} `}launcher ok`,
      });
  }
  const dir = agentProfileDir(name, agent, env);
  if (!existsSync(dir)) {
    out.push({ area, level: "fail", text: `profile ${name}: ${tildify(dir, env)} does not exist`, fix: repair(name) });
    return out;
  }
  const hub = agentHub(agent, env);
  const shared: string[] = [...a.sharedDirs, ...a.sharedFiles];
  for (const item of shared) {
    const path = join(dir, item);
    const target = join(hub, item);
    if (isLinkTo(path, target)) continue;
    if (existsSync(path))
      out.push({
        area,
        level: "warn",
        text: `profile ${name}: ${item} is a local copy, not shared`,
        fix: repair(name),
      });
    else if (existsSync(target))
      out.push({ area, level: "warn", text: `profile ${name}: missing link for ${item}`, fix: repair(name) });
  }
  for (const w of a.doctorWarnings?.(dir) ?? [])
    out.push({ area, level: "warn", text: `profile ${name}: ${w}`, fix: repair(name) });
  if (a.perAccount) {
    const known = new Set<string>([...shared, ...a.perAccount.items]);
    let entries: string[] = [];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      entries = [];
    }
    for (const item of entries) {
      if (known.has(item) || !lexists(join(dir, item)) || a.perAccount.ignore.test(item)) continue;
      out.push({
        area,
        level: "info",
        text: `profile ${name}: ${item} is new and unclassified: decide whether to share it`,
      });
    }
  }
  return out;
}

export async function collectChecks(env: NodeJS.ProcessEnv): Promise<Check[]> {
  const p = paths(env);
  const checks: Check[] = [];
  const add = (area: string, level: Level, text: string, how: { fix?: Fix; hint?: string; manual?: string } = {}) =>
    checks.push({ area, level, text, ...how });

  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) add("system", "ok", `node ${process.versions.node}`);
  else
    add("system", "fail", `node ${process.versions.node}, and turno needs 20 or newer`, {
      manual: "install Node.js 20 or newer (https://nodejs.org)",
    });
  // Every agent is listed; only one that a profile uses can fail.
  let early: Config | undefined;
  try {
    early = loadConfig(env);
  } catch {
    early = undefined;
  }
  const names = early ? listProfiles(early, env) : [];
  const used = new Set<AgentId>(early ? names.map((n) => agentOf(n, early!)) : []);
  for (const id of AGENT_IDS) {
    const a = adapter(id);
    const at = findOnPath(a.command, env);
    // An install line is a command, or a page to follow when the agent has no one-line install.
    const install = /^https?:\/\//.test(a.install) ? { manual: `install it: ${a.install}` } : { hint: a.install };
    if (at) add("system", used.has(id) ? "ok" : "info", `${a.command} at ${tildify(at, env)}`);
    else if (used.has(id)) add("system", "fail", `${a.command} not found on PATH, and profiles use it`, install);
    else add("system", "info", `${a.command} not installed`, install);
  }
  const { pathAdvice } = await import("./profile.js");
  const advice = names.length ? pathAdvice(env) : undefined;
  if (advice) {
    add(
      "system",
      "warn",
      `${tildify(p.bin, env)} is not on your PATH, so launchers like ${launcherName(names[0]!, agentOf(names[0]!, early!))} will not be found (turno ${names[0]} works meanwhile)`,
      {
        manual: `${advice.charAt(0).toLowerCase()}${advice.slice(1)}, then open a new terminal`,
      },
    );
  }
  const { secretStoreLabel } = await import("../security.js");
  const store = secretStoreLabel(env);
  if (store === "none")
    add("system", "info", "secret store: none (keychain: references cannot resolve; env: ones work)", {
      manual: "install secret-tool (libsecret) to use keychain: references",
    });
  else add("system", "ok", `secret store: ${store}`);
  const chrome = env.TURNO_CHROME_APP || "/Applications/Google Chrome.app";
  if (existsSync(chrome)) add("system", "ok", "Google Chrome installed");
  else
    add("system", "warn", "Google Chrome not found: claude.ai links open in the default browser", {
      manual: "install Google Chrome, or set TURNO_CHROME_APP to where it is",
    });

  const { recordedVersion, finishUpgrade } = await import("./upgrade.js");
  const version = packageInfo().version;
  const recorded = recordedVersion(env);
  if (recorded && recorded !== version) {
    add("turno", "warn", `turno ${version} runs, but ${recorded} set up the launchers`, {
      fix: { label: "turno upgrade --finish", run: (io) => finishUpgrade(io, { sync: "no" }) },
    });
  } else add("turno", "ok", `turno ${version}`);
  const newer = availableUpdate(env);
  if (newer) add("turno", "info", `turno ${newer} is available`, { hint: "turno upgrade" });

  let config: Config | undefined;
  const editConfig = { hint: "turno config edit" };
  try {
    config = loadConfig(env);
    if (existsSync(p.configFile)) add("config", "ok", `${tildify(p.configFile, env)} parses`);
    else if (migrationPending(env))
      add("config", "info", `no ${tildify(p.configFile, env)} yet, but a bash claudio config is there`, {
        hint: "turno migrate",
      });
    else add("config", "info", `no ${tildify(p.configFile, env)} (defaults)`);
    for (const f of configFindings(config, env))
      add("config", "warn", f.text, f.manual ? { manual: f.manual } : { hint: f.hint ?? "turno config edit" });
  } catch (err) {
    add("config", "fail", (err as Error).message, editConfig);
  }
  let manifest: Manifest | undefined;
  try {
    const m = loadManifest(env);
    manifest = m;
    if (existsSync(p.mcpFile))
      add("config", "ok", `${tildify(p.mcpFile, env)} parses (${Object.keys(m.servers).length} servers)`);
    else add("config", "info", `no ${tildify(p.mcpFile, env)} yet`, { hint: "turno mcp import" });
  } catch (err) {
    add("config", "fail", (err as Error).message, {
      manual: `correct ${tildify(p.mcpFile, env)} where the error points`,
    });
  }
  if (existsSync(p.accountsFile)) {
    try {
      const reg = loadRegistry(env);
      add("config", "ok", `${tildify(p.accountsFile, env)} parses`);
      // Without read_tools a delegated read is a write: confirmed, with every tool.
      const noReads = Object.values(reg.accounts)
        .filter((a) => !a.readTools?.length)
        .map((a) => a.id)
        .sort();
      if (noReads.length) {
        add(
          "config",
          "warn",
          `accounts without read_tools: ${noReads.join(", ")}; delegated reads get every tool of the account and ask like writes`,
          {
            manual: `add read_tools to each of them in ${tildify(p.accountsFile, env)}`,
          },
        );
      }
    } catch (err) {
      add("config", "fail", (err as Error).message, {
        manual: `correct ${tildify(p.accountsFile, env)} where the error points`,
      });
    }
  }

  if (config) {
    const profiles = listProfiles(config, env);
    if (profiles.length === 0) add("profiles", "info", "no profiles yet", { hint: "turno profile add <name>" });
    for (const name of profiles) {
      checks.push(...profileChecks(name, agentOf(name, config), env));
    }
  }
  const legacyBin = join(p.bin, "claudio");
  if (isLegacyScript(legacyBin))
    add("turno", "info", `${tildify(legacyBin, env)} is still the bash claudio (the cutover points it at turno)`);

  try {
    const { bypassingServers } = await import("./mcp.js");
    const b = await bypassingServers(env);
    for (const s of b.plugins)
      add("mcp", "info", `plugin server ${s.plugin}/${s.name} starts in every session`, { hint: "turno mcp doctor" });
    // turno mcp sync replaces a hub entry with the gateway's when mcp.toml serves it to the profile the hub belongs to.
    const hubProfile = config?.system || "default";
    for (const d of b.direct) {
      const def = manifest?.servers[d.name];
      const how = !d.inManifest
        ? { hint: "turno mcp import" }
        : def && servesProfile(def, hubProfile)
          ? { fix: syncFix }
          : {
              manual: `remove ${d.name} from ${tildify(p.hubConfig, env)}, or serve it to profile ${hubProfile} in mcp.toml`,
            };
      add("mcp", "warn", `${d.name} runs outside mcpd`, how);
    }
    const { describeLogin, oauthLogins } = await import("./mcp-oauth.js");
    for (const l of await oauthLogins(env)) {
      const ok = l.state === "logged in" || l.state === "expired";
      const login = `turno mcp login ${l.server}${l.variant === "default" ? "" : ` --profile ${l.variant}`}`;
      const said = describeLogin(l);
      // describeLogin ends with the login command; the fix line shows it instead.
      const text = said.endsWith(`: ${login}`) ? said.slice(0, -login.length - 2) : said;
      const how = ok
        ? {}
        : said !== text
          ? { hint: login }
          : { manual: "install a secret store (macOS Keychain or secret-tool) so turno can read the login" };
      add(
        "mcp",
        ok ? "ok" : "warn",
        `${l.server}${l.variant === "default" ? "" : `@${l.variant}`} OAuth: ${text}`,
        how,
      );
    }
  } catch {
    /* a broken mcp.toml is reported above */
  }
  if (manifest) checks.push(...envRefChecks(manifest, env));

  const settings = join(p.hub, "settings.json");
  const line = currentStatusLine(settings);
  if (isTurnoStatusLine(line)) add("look", "ok", "status line: turno statusline");
  else
    add("look", "info", `status line: ${statusLineLabel(line, env)} in ${tildify(settings, env)}`, {
      hint: "turno ui install",
    });
  const fontDir = userFontDir(env);
  if (fontDir) {
    const fonts = checkFonts(FALLBACK, fontDir);
    const have = fonts.filter((f) => f.state === "installed").length;
    if (have === fonts.length) add("look", "ok", `font: ${FALLBACK.family} installed`);
    else
      add("look", "info", `font: ${FALLBACK.family} ${have}/${fonts.length} files in ${tildify(fontDir, env)}`, {
        hint: "turno ui install",
      });
  }

  checks.push(...(await mcpdSection(env)));
  return checks;
}

// ---- mcpd section: service file, token mode, port owner, start errors, synced ports.
// The checks live in mcpd/health.ts; keep this section separate from the rest of doctor.
async function mcpdSection(env: NodeJS.ProcessEnv): Promise<Check[]> {
  const { mcpdChecks } = await import("../../mcpd/health.js");
  return (await mcpdChecks(env)).map((c) => ({ area: "mcpd", ...c }));
}
// ---- end of the mcpd section

// ---- security section: `turno doctor --security` runs only these checks.
async function securitySection(env: NodeJS.ProcessEnv): Promise<Check[]> {
  return (await import("../security.js")).securityChecks(env);
}
// ---- end of the security section

/** Screen sections in order, and the check areas each one holds. */
const SECTIONS: readonly (readonly [string, (area: string) => boolean])[] = [
  ["System", (a) => a === "system" || a === "turno"],
  ["Config", (a) => a === "config"],
  ["Profiles", (a) => a === "profiles" || a.startsWith("profile ")],
  ["MCP", (a) => a === "mcp"],
  ["Look", (a) => a === "look"],
  ["Gateway", (a) => a === "mcpd"],
  ["Security", (a) => a === "security"],
];

function sectionOf(area: string): string {
  return SECTIONS.find(([, has]) => has(area))?.[0] ?? area.charAt(0).toUpperCase() + area.slice(1);
}

interface Counts {
  ok: number;
  warn: number;
  fail: number;
  skip: number;
}

function countChecks(checks: readonly Check[]): Counts {
  const n: Counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) n[statusOf(c.level)]++;
  return n;
}

/** "12 ok, 2 warnings, 1 failure, 3 skipped": zero problems and skips are left out. */
function countsText(
  n: Counts,
  paint: {
    ok?: (s: string) => string;
    warn?: (s: string) => string;
    err?: (s: string) => string;
    muted?: (s: string) => string;
  } = {},
): string {
  const id = (s: string) => s;
  const parts = [(paint.ok ?? id)(`${n.ok} ok`)];
  if (n.warn) parts.push((paint.warn ?? id)(`${n.warn} warning${n.warn === 1 ? "" : "s"}`));
  if (n.fail) parts.push((paint.err ?? id)(`${n.fail} failure${n.fail === 1 ? "" : "s"}`));
  if (n.skip) parts.push((paint.muted ?? id)(`${n.skip} skipped`));
  return parts.join(", ");
}

/** The fix commands of every problem, failures first, each once: `next` in `--json`. */
function nextCommands(checks: readonly Check[]): string[] {
  const out: string[] = [];
  for (const level of ["fail", "warn"] as const) {
    for (const c of checks) {
      const cmd = c.level === level ? fixCommand(c) : undefined;
      if (cmd && !out.includes(cmd)) out.push(cmd);
    }
  }
  return out;
}

/** `--summary`: one line with the counts and the first fix, for hooks and the status line. */
function summaryLine(checks: readonly Check[], opts: { security?: boolean } = {}): string {
  const head = `turno doctor${opts.security ? " --security" : ""}: ${countsText(countChecks(checks))}`;
  const problems = checks.filter(isProblem);
  if (!problems.length) return head;
  const [first] = nextCommands(checks);
  if (first) return `${head}; fix: ${first}`;
  return `${head}; turno doctor${opts.security ? " --security" : ""} shows the manual steps`;
}

/** The doctor screen as lines: sections, one row per check with its fix, and a summary. */
function renderDoctor(
  checks: readonly Check[],
  io: Pick<Io, "env" | "isTty">,
  opts: {
    ms: number;
    security?: boolean;
    fixed?: boolean;
    nerd?: boolean;
    colors?: Record<string, { color?: string | number }>;
  },
): string[] {
  const s = style(io, { nerd: opts.nerd });
  const out: string[] = [];
  const order = [...SECTIONS.map(([name]) => name)];
  for (const c of checks) if (!order.includes(sectionOf(c.area))) order.push(sectionOf(c.area));
  const STATE = { ok: "ok", warn: "warn", fail: "err", skip: "skip" } as const;
  const profileNames = checks.filter((c) => c.area.startsWith("profile ")).map((c) => c.area.slice("profile ".length));
  const pill = (name: string) => s.profile(name, opts.colors ? profileColor(opts.colors, name) : undefined);
  const pillWidth = Math.max(0, ...profileNames.map((n) => visibleWidth(pill(n))));
  // Fix lines start under the text, after the icon column.
  const iconWidth = Math.max(...(["ok", "warn", "err", "skip"] as const).map((n) => visibleWidth(s.icon(n))));
  const under = " ".repeat(2 + iconWidth + 1);
  const fixFlag = `turno doctor${opts.security ? " --security" : ""} --fix`;

  for (const section of order) {
    const rows = checks.filter((c) => sectionOf(c.area) === section);
    if (!rows.length) continue;
    if (out.length) out.push("");
    out.push(s.header(section));
    for (const [i, c] of rows.entries()) {
      const status = statusOf(c.level);
      let text = c.text;
      let lead = "";
      if (c.area.startsWith("profile ")) {
        const name = c.area.slice("profile ".length);
        const prefix = `profile ${name}: `;
        if (text.startsWith(prefix)) text = text.slice(prefix.length);
        // On a terminal the pill opens each profile's rows; plain text names it on every row, for grep.
        const first = rows[i - 1]?.area !== c.area;
        lead = `${padEnd(first || !s.color ? pill(name) : "", pillWidth)}  `;
      }
      const body = status === "skip" ? s.muted(text) : status === "fail" ? s.err(text) : text;
      out.push(s.wrap(`  ${padEnd(s.icon(STATE[status]), iconWidth)} ${lead}`, body));
      if (status === "ok") continue;
      const cmd = fixCommand(c);
      // Rows in a run with the same fix (one profile's links) share one fix line, after the last.
      const nextRow = rows[i + 1];
      if (cmd && nextRow && nextRow.area === c.area && statusOf(nextRow.level) !== "ok" && fixCommand(nextRow) === cmd)
        continue;
      const label = status === "skip" ? "optional:" : "fix:";
      if (cmd) {
        const auto = c.fix && isProblem(c) && cmd !== fixFlag ? s.muted(` (${fixFlag} runs it)`) : "";
        out.push(s.wrap(`${under}${s.muted(label)} `, `${status === "skip" ? s.muted(cmd) : s.bold(cmd)}${auto}`));
      } else if (c.manual) {
        out.push(
          s.wrap(
            `${under}${s.muted(status === "skip" ? label : "manual:")} `,
            status === "skip" ? s.muted(c.manual) : c.manual,
          ),
        );
      }
    }
  }

  const n = countChecks(checks);
  out.push(
    "",
    `${countsText(n, { ok: s.ok, warn: s.warn, err: s.err, muted: s.muted })} ${s.muted(`in ${duration(opts.ms)}`)}`,
  );
  const problems = checks.filter(isProblem);
  const repairable = problems.filter((c) => c.fix).length;
  if (repairable && !opts.fixed) {
    const label = s.lead("next", s.bold(s.accent("Next")));
    const what =
      repairable === problems.length
        ? `repairs ${repairable === 1 ? "it" : `all ${repairable}`}`
        : `repairs ${repairable} of ${problems.length}; the others name their fix above`;
    out.push(s.wrap(`${label}  `, `${s.bold(fixFlag)}  ${s.muted(what)}`));
  }
  return out;
}

/**
 * `--report`: a Markdown block for an issue (versions, OS, agents, paths, mcpd, the findings),
 * with no tokens or secret values. Exits like doctor does.
 */
async function report(io: Io, checks: readonly Check[], security: boolean): Promise<number> {
  let config: Config | undefined;
  try {
    config = loadConfig(io.env);
  } catch {
    config = undefined;
  }
  const mcpd = await mcpdStatus(io.env, config);
  let status: Record<string, unknown> | undefined;
  if (mcpd.running) {
    const { mcpdRequest } = await import("./mcp.js");
    const r = await mcpdRequest(io.env, "GET", "/status");
    if (r !== "down" && r.status === 200 && typeof r.body === "object" && r.body !== null)
      status = r.body as Record<string, unknown>;
  }
  const { reportMarkdown } = await import("../diagnostics.js");
  const lines = await reportMarkdown(io.env, {
    counts: countChecks(checks),
    checks: checks.map((c) => ({
      status: statusOf(c.level),
      area: c.area,
      text: c.text,
      ...(fixCommand(c) ? { fix: fixCommand(c)! } : {}),
    })),
    mcpd,
    ...(status ? { status } : {}),
    security,
  });
  for (const l of lines) io.out(l);
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}

export async function doctor(
  io: Io,
  opts: {
    fix?: boolean;
    json?: boolean;
    security?: boolean;
    summary?: boolean;
    report?: boolean;
    parsed?: Parsed;
  } = {},
): Promise<number> {
  const start = Date.now();
  const collect = opts.security ? securitySection : collectChecks;
  const quiet = opts.json || opts.summary;
  let checks = await collect(io.env);
  if (opts.report) return report(io, checks, Boolean(opts.security));
  if (opts.fix) {
    const fixes = new Map<string, Fix>();
    for (const c of checks) if (c.fix && isProblem(c) && !fixes.has(c.fix.label)) fixes.set(c.fix.label, c.fix);
    const s = quiet ? undefined : style(io);
    for (const f of fixes.values()) {
      if (s) io.out(s.bold(`$ ${f.label}`));
      await f.run(quiet ? { ...io, out: () => {} } : io);
    }
    if (fixes.size) {
      if (s) io.out("");
      checks = await collect(io.env);
    } else if (s) io.out(`Nothing to fix automatically.\n`);
  }
  const failed = checks.some((c) => c.level === "fail");
  const ms = Date.now() - start;
  if (opts.json) {
    emit(io, opts.parsed, DOCTOR_JSON, {
      ok: !failed,
      counts: countChecks(checks),
      ms,
      next: nextCommands(checks),
      checks: checks.map(({ fix, hint, manual, ...c }) => {
        const status = statusOf(c.level);
        const command = status === "ok" ? undefined : (fix?.label ?? hint);
        return {
          ...c,
          status,
          fix: command ?? null,
          auto: Boolean(fix) && status !== "ok" && status !== "skip",
          manual: status === "ok" ? null : (manual ?? null),
        };
      }),
    });
    return failed ? 1 : 0;
  }
  if (opts.summary) {
    io.out(summaryLine(checks, { security: opts.security }));
    return failed ? 1 : 0;
  }
  const look = lookOf(io.env);
  for (const line of renderDoctor(checks, io, { ms, security: opts.security, fixed: opts.fix, ...look })) io.out(line);
  return failed ? 1 : 0;
}

/** Icons and profile colors from config.toml, as `turno status` uses them; defaults when it does not parse. */
function lookOf(env: NodeJS.ProcessEnv): { nerd: boolean; colors?: Record<string, { color?: string | number }> } {
  try {
    const config = loadConfig(env);
    return {
      nerd: config.icons === "nerd" || (config.icons === "auto" && nerdHere(env, config.nerdTerminals)),
      colors: config.profiles,
    };
  } catch {
    return { nerd: false };
  }
}

export const command: Command = {
  summary: "check everything (system, config, profiles, MCP, look, mcpd) and fix what is safe to fix",
  usage: [
    "Usage: turno doctor [--security] [--fix] [--json | --summary | --report]",
    "",
    "One row per check, in sections. Under each problem: the command that fixes it",
    "(fix: ...) or the manual step. Exits 1 when a check fails; warnings exit 0.",
    "",
    '--fix runs every repair marked "turno doctor --fix runs it" (relink a profile,',
    "rewrite launchers, finish an upgrade, start mcpd, sync configs), then checks",
    "again. --summary prints one line, the counts and the first fix, for hooks and",
    "status lines. --json gives each check a status (ok, warn, fail or skip), fix (a",
    "command or null), auto (whether --fix runs it) and manual, plus counts, ms and",
    "next (the fix commands, failures first).",
    "",
    "--report prints a Markdown block to paste in an issue: turno, Node and OS",
    "versions, each agent and its version, mcpd's state, the warnings and failures,",
    "and every path turno uses. It holds no tokens or secret values; profile and",
    "server names appear.",
    "",
    "--security runs the security checks instead: who can read turno's folders, who",
    "holds the mcpd port, literal secrets in mcp.toml, agent configs and backups, MCP",
    "servers without an exact version, the age of the mcpd token and the audit log's",
    "hash chain. With --fix it narrows file modes under turno's folders.",
    "",
    "Examples:",
    "  $ turno doctor",
    "  $ turno doctor --fix",
    "  $ turno doctor --summary",
    "  $ turno doctor --security --json",
    "  $ turno doctor --report | pbcopy  # paste it in an issue",
  ].join("\n"),
  flags: ["--security", "--fix", "--json", "--summary", "--report"],
  json: DOCTOR_JSON,
  async run(args, io) {
    const p = parseFlags(
      args,
      {
        security: { type: "boolean" },
        fix: { type: "boolean" },
        summary: { type: "boolean" },
        report: { type: "boolean" },
        ...JSON_FLAG,
      },
      0,
    );
    const modes = (["json", "summary", "report"] as const).filter((m) => bool(p, m));
    if (modes.length > 1) return fail(`${modes.map((m) => `--${m}`).join(" and ")} do not go together`);
    if (bool(p, "report") && bool(p, "fix"))
      return fail("--report only reads; run turno doctor --fix first, then --report");
    return doctor(io, {
      fix: bool(p, "fix"),
      json: bool(p, "json"),
      security: bool(p, "security"),
      summary: bool(p, "summary"),
      report: bool(p, "report"),
      parsed: p,
    });
  },
};

/**
 * What `turno config path --all` and `turno doctor --report` show: every path turno uses, and a
 * Markdown block for an issue with versions, agents, paths, mcpd and the doctor findings. Nothing
 * here prints a token, a secret value or a variable's value: paths are shown with `~`, and the
 * doctor findings already name secrets only by key.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { arch, release } from "node:os";
import { join } from "node:path";
import { AGENT_IDS, type AgentId, adapter, agentHub, agentProfileDir } from "../agents/index.js";
import { type Config, loadConfig } from "../core/config.js";
import { paths, tildify } from "../core/paths.js";
import { agentOf, listProfiles } from "../core/profiles.js";
import { detectInstall, packageInfo } from "../core/version.js";
import { plistPath } from "../mcpd/launchd.js";
import { daemonFiles } from "../mcpd/state.js";
import { unitPath } from "../mcpd/systemd.js";
import { userFontDir } from "../ui/fonts.js";
import { compileCacheDir } from "./compile-cache.js";
import { findOnPath, launcherName } from "./launchers.js";

/** One path turno reads or writes. */
export interface PathEntry {
  /** A short stable name, like `config` or `profile work`. */
  name: string;
  path: string;
  /** What turno keeps there. */
  about: string;
}

function configOrNone(env: NodeJS.ProcessEnv): Config | undefined {
  try {
    return loadConfig(env);
  } catch {
    return undefined;
  }
}

/**
 * Every path turno uses on this machine, in a stable order: its own config, state and data, the
 * launchers and the service file, each agent's hub, and each profile's folder and launcher.
 */
export function allPaths(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): PathEntry[] {
  const p = paths(env);
  const d = daemonFiles(env);
  const out: PathEntry[] = [
    { name: "config dir", path: p.config, about: "turno's configuration (TURNO_CONFIG_DIR)" },
    { name: "config", path: p.configFile, about: "profiles, folder rules, defaults" },
    { name: "mcp", path: p.mcpFile, about: "MCP servers behind mcpd" },
    { name: "accounts", path: p.accountsFile, about: "service accounts (turno identity)" },
    { name: "state dir", path: p.state, about: "state, logs and backups (TURNO_STATE_DIR)" },
    { name: "backups", path: p.backupsDir, about: "the journal turno undo reads" },
    { name: "logs", path: p.logsDir, about: "mcpd.log and calls.jsonl" },
    { name: "mcpd log", path: d.log, about: "what mcpd did" },
    { name: "call log", path: d.calls, about: "tool calls mcpd relayed (turno mcp log)" },
    { name: "mcpd token", path: p.mcpdToken, about: "the gateway's master token (mode 600)" },
    { name: "mcpd port", path: p.mcpdPort, about: "the port mcpd listens on" },
    { name: "mcpd lock", path: d.lock, about: "the running mcpd's pid" },
    {
      name: "profile tokens",
      path: join(p.state, "mcpd-tokens"),
      about: "each profile's gateway token, for launchers",
    },
    { name: "managed entries", path: p.mcpdManaged, about: "agent config entries turno mcp sync wrote" },
    { name: "run records", path: p.runDir, about: "which profile each launcher started" },
    { name: "usage", path: p.usageDir, about: "usage snapshots for the status line" },
    { name: "exhausted", path: p.exhaustedDir, about: "exhausted marks (turno limit)" },
    { name: "audit log", path: p.auditLog, about: "accounts bridge audit log" },
    { name: "data dir", path: p.data, about: "installed servers and browser data (TURNO_DATA_DIR)" },
    { name: "servers", path: p.serversDir, about: "packages turno mcp install installed" },
    { name: "descriptions", path: p.mcpdCacheDir, about: "cached tool lists of each server" },
    { name: "browser", path: p.browserDir, about: "browser identities" },
    {
      name: "chrome profiles",
      path: configOrNone(env)?.open.chromeDir ?? p.chromeProfilesDir,
      about: "Chrome profiles of turno open",
    },
    { name: "compile cache", path: compileCacheDir(env), about: "Node's compiled code of turno" },
    { name: "launchers", path: p.bin, about: "claude-<p>, codex-<p>, turno-auto, turno-open (TURNO_BIN)" },
  ];
  if (platform === "darwin")
    out.push({ name: "service", path: plistPath(env), about: "the LaunchAgent that keeps mcpd running" });
  if (platform === "linux")
    out.push({ name: "service", path: unitPath(env), about: "the systemd user unit that keeps mcpd running" });
  const fonts = userFontDir(env, platform);
  if (fonts) out.push({ name: "fonts", path: fonts, about: "the status line font (turno ui install)" });
  out.push({ name: "claude config", path: p.hubConfig, about: "plain claude's .claude.json (TURNO_HUB_CONFIG)" });
  for (const id of AGENT_IDS)
    out.push({
      name: `${id} hub`,
      path: agentHub(id, env),
      about: `${adapter(id).label}'s own folder, shared by its profiles`,
    });
  const config = configOrNone(env);
  if (config) {
    for (const name of listProfiles(config, env)) {
      const agent = agentOf(name, config);
      out.push({
        name: `profile ${name}`,
        path: agentProfileDir(name, agent, env),
        about: `${adapter(agent).label} profile folder`,
      });
      out.push({ name: `launcher ${name}`, path: join(p.bin, launcherName(name, agent)), about: `opens ${name}` });
    }
  }
  if (existsSync(p.legacyConfig))
    out.push({
      name: "legacy config",
      path: p.legacyConfig,
      about: "the bash claudio config (turno migrate reads it)",
    });
  return out;
}

/** `<command> --version`, first line, or undefined when it does not answer within 3 s. */
function versionOf(file: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, ["--version"], { env, timeout: 3000, encoding: "utf8" }, (err, stdout) => {
      const line = String(stdout ?? "")
        .trim()
        .split("\n")[0]
        ?.trim();
      resolve(err || !line ? undefined : line.slice(0, 80));
    });
  });
}

/** The doctor findings a report lists: status, area, text and the fix, without ok rows. */
export interface ReportCheck {
  status: "ok" | "warn" | "fail" | "skip";
  area: string;
  text: string;
  fix?: string;
}

export interface ReportInput {
  counts: { ok: number; warn: number; fail: number; skip: number };
  checks: readonly ReportCheck[];
  /** mcpd's state, from doctor. */
  mcpd: { running: boolean; port: number; text: string };
  /** mcpd's /status body when it answered. */
  status?: Record<string, unknown>;
  security?: boolean;
}

/** Markdown text in a table cell: no pipes or line breaks. */
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

/**
 * The `turno doctor --report` block: Markdown to paste in an issue. Profile and server names
 * appear (they say which check is which); tokens, secret values and variable values never do.
 */
export async function reportMarkdown(
  env: NodeJS.ProcessEnv,
  input: ReportInput,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  const t = (s: string) => tildify(s, env);
  const pkg = packageInfo();
  const install = detectInstall();
  const config = configOrNone(env);
  const profiles = config ? listProfiles(config, env) : [];
  const byAgent = new Map<AgentId, number>();
  for (const n of profiles) byAgent.set(agentOf(n, config!), (byAgent.get(agentOf(n, config!)) ?? 0) + 1);
  const agents = await Promise.all(
    AGENT_IDS.map(async (id) => {
      const a = adapter(id);
      const at = findOnPath(a.command, env);
      return { id, label: a.label, command: a.command, at, version: at ? await versionOf(at, env) : undefined };
    }),
  );
  const shell = env.SHELL ? env.SHELL.split("/").pop() : undefined;
  const terminal = env.TERM_PROGRAM
    ? `${env.TERM_PROGRAM}${env.TERM_PROGRAM_VERSION ? ` ${env.TERM_PROGRAM_VERSION}` : ""}`
    : env.TERM;
  const out: string[] = [
    `### turno doctor${input.security ? " --security" : ""} --report`,
    "",
    "| | |",
    "|---|---|",
    `| turno | ${pkg.version} (${install.method}) |`,
    `| node | ${process.versions.node} |`,
    `| os | ${platform} ${release()} ${arch()} |`,
    ...(shell ? [`| shell | ${cell(shell)} |`] : []),
    ...(terminal ? [`| terminal | ${cell(terminal)} |`] : []),
    `| config.toml | ${existsSync(paths(env).configFile) ? (config ? "parses" : "does not parse") : "none"} |`,
    `| profiles | ${profiles.length ? [...byAgent].map(([id, n]) => `${n} ${id}`).join(", ") : "none"} |`,
    "",
    "**Agents**",
    "",
    "| agent | command | version | profiles |",
    "|---|---|---|---|",
    ...agents.map(
      (a) =>
        `| ${a.label} | ${a.at ? cell(t(a.at)) : `${a.command} (not found)`} | ${a.version ? cell(a.version) : "-"} | ${byAgent.get(a.id) ?? 0} |`,
    ),
    "",
    "**mcpd**",
    "",
  ];
  const s = input.status;
  if (input.mcpd.running && s) {
    const instances = Array.isArray(s.instances) ? s.instances.length : 0;
    const parts = [
      `running on port ${input.mcpd.port}`,
      typeof s.version === "string" ? `version ${s.version}` : "",
      typeof s.startedAt === "string" ? `since ${s.startedAt}` : "",
      `${typeof s.sessions === "number" ? s.sessions : 0} sessions`,
      `${instances} server processes`,
    ].filter(Boolean);
    out.push(`- ${parts.join(", ")}`);
  } else out.push(`- ${cell(input.mcpd.text)}`);
  const c = input.counts;
  out.push(
    "",
    "**Doctor**",
    "",
    `- ${c.ok} ok, ${c.warn} warnings, ${c.fail} failures, ${c.skip} skipped`,
    ...input.checks
      .filter((x) => x.status === "warn" || x.status === "fail")
      .map((x) => `- ${x.status}: ${cell(x.text)}${x.fix ? ` (fix: \`${cell(x.fix)}\`)` : ""}`),
    "",
    "<details><summary>Paths</summary>",
    "",
    "| name | path | exists |",
    "|---|---|---|",
    ...allPaths(env, platform).map(
      (e) => `| ${cell(e.name)} | ${cell(t(e.path))} | ${existsSync(e.path) ? "yes" : "no"} |`,
    ),
    "",
    "</details>",
  );
  return out;
}

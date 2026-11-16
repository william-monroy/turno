import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentId, adapter, agentHub, agentProfileDir } from "../../agents/index.js";
import { isValidProfileName, loadConfig } from "../../core/config.js";
import { setValue } from "../../core/toml-edit.js";
import { paths, profileDir, tildify } from "../../core/paths.js";
import { agentOf } from "../../core/profiles.js";
import { profileBusy } from "../../core/sessions.js";
import { type Command, type Io, fail } from "../io.js";
import { SHARED_DIRS, launcherName, turnoCommand, writeHelperLaunchers, writeLauncher } from "../launchers.js";

export { SHARED_DIRS };

/** Hub files shared by every profile (linked only when they exist in the hub). */
export const SHARED_FILES = ["CLAUDE.md", "settings.json", "keybindings.json", "statusline-command.sh", ".mcp.json"] as const;

/**
 * Owned by each account and never linked. history.jsonl cannot be a symlink: Claude Code
 * ignores it unless it is a regular file with a single link.
 */
export const PER_ACCOUNT = [
  ".claude.json",
  ".credentials.json",
  "history.jsonl",
  "backups",
  "daemon",
  "daemon.log",
  "daemon-auth-cooldown",
  "daemon-auth-status.json",
  "daemon.lock",
  "daemon.status.json",
  "feedback",
  "jobs",
  "policy-limits.json",
  "policy-limits.json.stamp.json",
  "policy-limits.json.signature.json",
  "remote-settings.json",
  "remote-settings.json.signature.json",
  "remote-settings.json.synced-at",
  "mcp-needs-auth-cache.json",
  "stats-cache.json",
  "telemetry",
  "shell-snapshots",
  "debug",
  ".last-cleanup",
  ".last-update-result.json",
  "computer-use.lock",
] as const;

/** Names a profile cannot take: every command, alias and legacy word. */
export const RESERVED = new Set([
  "auto", "which", "resolve", "sessions", "usage", "exhausted", "available", "hook", "setup", "status",
  "open", "migrate", "doctor", "statusline", "handoff", "mcp", "mcpd", "secret", "accounts", "browser", "ui", "help", "version",
  "cuenta", "resolver", "sesiones", "uso", "agotada", "disponible", "limite", "abrir", "sync-mcp",
  "profile", "navegador",
  "run", "limit", "session", "identity", "config", "undo", "upgrade", "completion", "__complete", "__update-check",
]);

export function checkName(name: string): void {
  if (!isValidProfileName(name)) fail(`invalid name: '${name}' (use lowercase letters, digits, - or _)`);
  if (RESERVED.has(name)) fail(`'${name}' is reserved`);
}

export { stamp } from "../../core/journal.js";
import { stamp } from "../../core/journal.js";

function lstat(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** Make <dir>/<item> a symlink to the hub, moving a local copy aside. */
function linkItem(dir: string, item: string, aside: string, io: Io, hub = paths(io.env).hub): void {
  const target = join(hub, item);
  const path = join(dir, item);
  const st = lstat(path);
  if (st?.isSymbolicLink()) {
    if (readlinkSync(path) === target) return;
    rmSync(path);
  } else if (st?.isDirectory() && readdirSync(path).length === 0) {
    rmdirSync(path);
  } else if (st) {
    mkdirSync(aside, { recursive: true });
    renameSync(path, join(aside, item));
    io.out(`  ! ${item} was a local copy: moved to ${tildify(aside, io.env)}/ (merge it by hand if useful)`);
  }
  symlinkSync(target, path);
  io.out(`  ↔ ${item}`);
}

const SEED_KEYS = ["mcpServers", "projects", "hasCompletedOnboarding", "lastOnboardingVersion", "theme"];

/** First .claude.json of a profile: user MCP servers and per-project state, never the account. */
function seedGlobalConfig(dir: string, io: Io): void {
  const dst = join(dir, ".claude.json");
  if (existsSync(dst)) {
    io.out("  = .claude.json already exists (turno mcp sync brings in new MCP servers)");
    return;
  }
  const src = paths(io.env).hubConfig;
  let hub: Record<string, unknown>;
  try {
    hub = JSON.parse(readFileSync(src, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  const seed: Record<string, unknown> = {};
  for (const k of SEED_KEYS) if (k in hub) seed[k] = hub[k];
  writeFileSync(dst, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
  chmodSync(dst, 0o600);
  const count = (v: unknown) => (v && typeof v === "object" ? Object.keys(v).length : 0);
  io.out(`  + .claude.json with ${count(seed.mcpServers)} MCP servers and ${count(seed.projects)} projects from the hub`);
}

export interface SetupOptions {
  /** Shell words that run turno, baked into turno-auto and turno-open. */
  turno?: string;
}

/**
 * Codex profiles: seed config.toml from the hub once, and always store the login in the
 * profile (`cli_auth_credentials_store = "file"`), so each CODEX_HOME has its own account.
 */
function prepareCodex(dir: string, io: Io): void {
  const file = join(dir, "config.toml");
  let text = "";
  if (existsSync(file)) text = readFileSync(file, "utf8");
  else {
    const hubFile = join(agentHub("codex", io.env), "config.toml");
    if (existsSync(hubFile)) {
      text = readFileSync(hubFile, "utf8");
      io.out("  + config.toml from ~/.codex (the login is not copied)");
    }
  }
  const next = setValue(text, undefined, "cli_auth_credentials_store", "file");
  if (next !== text || !existsSync(file)) {
    writeFileSync(file, next, { mode: 0o600 });
    io.out('  + cli_auth_credentials_store = "file" (the login stays in this profile)');
  }
  chmodSync(file, 0o600);
}

/** Profile of an agent other than Claude Code: its directory, hub links, config, launcher. */
function setupAgentProfile(name: string, agent: AgentId, io: Io): void {
  const a = adapter(agent);
  const hub = agentHub(agent, io.env);
  const dir = agentProfileDir(name, agent, io.env);
  const aside = join(dir, `.aside-${stamp()}`);
  io.out(`▸ ${name} (${a.label}) → ${tildify(dir, io.env)}`);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  for (const item of a.sharedDirs) {
    mkdirSync(join(hub, item), { recursive: true });
    linkItem(dir, item, aside, io, hub);
  }
  for (const item of a.sharedFiles) {
    if (existsSync(join(hub, item))) linkItem(dir, item, aside, io, hub);
  }
  if (agent === "codex") prepareCodex(dir, io);
  writeLauncher(name, io.env, agent);
  io.out(`  + command ${launcherName(name, agent)}`);
}

export function setupProfiles(names: string[], io: Io, opts: SetupOptions = {}): void {
  if (names.length === 0) fail("usage: turno setup <profile>...");
  for (const name of names) checkName(name);
  const p = paths(io.env);
  const config = loadConfig(io.env);
  for (const name of names) {
    const agent = agentOf(name, config);
    if (agent !== "claude") {
      setupAgentProfile(name, agent, io);
      continue;
    }
    if (!existsSync(p.hub)) {
      // Claude Code creates it on first run; profiles need it now to link the shared folders.
      mkdirSync(p.hub, { recursive: true, mode: 0o700 });
      io.out(`  + created ${tildify(p.hub, io.env)} (the folder every Claude Code profile shares)`);
    }
    const dir = profileDir(name, io.env);
    const aside = join(dir, `.aside-${stamp()}`);
    io.out(`▸ ${name} → ${tildify(dir, io.env)}`);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
    for (const item of SHARED_DIRS) {
      if (item === "sessions" && !lstat(join(dir, item))?.isSymbolicLink() && profileBusy(name, io.env, config)) {
        io.out("  ! sessions: this profile has open sessions; close them and run setup again");
        continue;
      }
      mkdirSync(join(p.hub, item), { recursive: true });
      linkItem(dir, item, aside, io);
    }
    for (const item of SHARED_FILES) {
      if (existsSync(join(p.hub, item))) linkItem(dir, item, aside, io);
    }
    seedGlobalConfig(dir, io);
    const history = join(dir, "history.jsonl");
    const hubHistory = join(p.hub, "history.jsonl");
    if (!existsSync(history) && lstat(hubHistory)?.isFile()) {
      copyFileSync(hubHistory, history);
      chmodSync(history, 0o600);
      io.out("  + history.jsonl (initial copy; the ↑ history cannot be shared)");
    }
    writeLauncher(name, io.env, "claude");
    io.out(`  + command claude-${name}`);
  }
  for (const written of writeHelperLaunchers(io.env, opts.turno ?? turnoCommand())) io.out(`+ command ${written}`);
}

export const command: Command = {
  summary: "create or repair ~/.claude-<profile> and its claude-<profile> command",
  usage: [
    "Usage: turno setup <profile>...",
    "",
    "Links the shared hub folders and files into the profile (local copies are moved",
    "to .aside-<timestamp>/), seeds .claude.json and history.jsonl, and writes the",
    "claude-<profile>, turno-auto and turno-open launchers.",
  ].join("\n"),
  async run(args, io) {
    setupProfiles(args, io);
    return 0;
  },
};

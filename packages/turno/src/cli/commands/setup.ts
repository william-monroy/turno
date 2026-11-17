import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentId, adapter, agentHub, agentProfileDir } from "../../agents/index.js";
import { type Config, isValidProfileName, loadConfig } from "../../core/config.js";
import { setValue } from "../../core/toml-edit.js";
import { paths, profileDir, tildify } from "../../core/paths.js";
import { agentOf } from "../../core/profiles.js";
import { profileBusy } from "../../core/sessions.js";
import { type Command, type Io, fail, plural } from "../io.js";
import { SHARED_DIRS, launcherName, refuseNpx, resolveTurnoCommand, writeHelperLaunchers, writeLauncher } from "../launchers.js";

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
  "uninstall", "init", "demo",
]);

export function checkName(name: string): void {
  if (!isValidProfileName(name)) fail(`invalid name: '${name}' (use lowercase letters, digits, - or _)`);
  if (RESERVED.has(name)) fail(`'${name}' is reserved`);
}

export { stamp } from "../../core/journal.js";
import { Journal, stamp } from "../../core/journal.js";

function lstat(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** True when `path` holds the person's own data: a file, or a folder that is not empty. */
function ownCopy(path: string): boolean {
  const st = lstat(path);
  if (!st || st.isSymbolicLink()) return false;
  if (st.isDirectory()) return readdirSync(path).length > 0;
  return true;
}

type Link = "linked" | "same" | "aside";

/**
 * Make <dir>/<item> a symlink to the hub, moving a local copy aside. Every step goes through
 * the journal, so `turno undo` removes the link and moves the copy back (ADR 0025).
 */
function linkItem(dir: string, item: string, aside: string, journal: Journal, hub: string): Link {
  const target = join(hub, item);
  const path = join(dir, item);
  const st = lstat(path);
  let result: Link = "linked";
  if (st?.isSymbolicLink()) {
    if (readlinkSync(path) === target) return "same";
    journal.unlink(path);
  } else if (st?.isDirectory() && readdirSync(path).length === 0) {
    journal.rmdir(path);
  } else if (st) {
    journal.mkdir(aside);
    journal.move(path, join(aside, item));
    result = "aside";
  }
  journal.symlink(target, path);
  return result;
}

/** Create a profile folder (0700) through the journal, so undo removes it while it is empty. */
function profileFolder(dir: string, journal: Journal): void {
  journal.mkdir(dir, 0o700);
  chmodSync(dir, 0o700);
}

/** Write a file the setup creates or changes (seeds, Codex config) through the journal. */
function writeOwn(file: string, text: string, journal: Journal): void {
  journal.save(file);
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
  journal.settle(file);
}

/** Shared items of a profile: [name, hub] pairs, hub files only when they exist. */
function sharedItems(name: string, agent: AgentId, env: NodeJS.ProcessEnv): { dir: string; hub: string; dirs: string[]; files: string[] } {
  if (agent === "claude") {
    const hub = paths(env).hub;
    return { dir: profileDir(name, env), hub, dirs: [...SHARED_DIRS], files: SHARED_FILES.filter((f) => existsSync(join(hub, f))) };
  }
  const a = adapter(agent);
  const hub = agentHub(agent, env);
  return { dir: agentProfileDir(name, agent, env), hub, dirs: [...a.sharedDirs], files: a.sharedFiles.filter((f) => existsSync(join(hub, f))) };
}

/**
 * The person's own files that setting up `names` would move to .aside-<stamp>/, so a command
 * can ask before it moves anything. `config` is the one the setup will run with (turno init
 * passes the config it is about to write, so a profile it declares has its own agent).
 */
export function localCopies(names: string[], env: NodeJS.ProcessEnv, config: Config = loadConfig(env)): { name: string; dir: string; items: string[] }[] {
  return names.map((name) => {
    const s = sharedItems(name, agentOf(name, config), env);
    return { name, dir: s.dir, items: [...s.dirs, ...s.files].filter((item) => ownCopy(join(s.dir, item))) };
  });
}

/** Print what linking did: one line, or every item with `verbose`. */
function reportLinks(name: string, label: string, dir: string, hub: string, results: [string, Link][], aside: string, io: Io, verbose: boolean): void {
  const env = io.env;
  const dirs = results.length;
  io.out(`▸ ${name}${label} → ${tildify(dir, env)}: shares ${plural(dirs, "item")} with ${tildify(hub, env)}${verbose || !dirs ? "" : " (-v lists them)"}`);
  if (verbose) for (const [item, r] of results) io.out(`  ${r === "same" ? "=" : "↔"} ${item}`);
  const moved = results.filter(([, r]) => r === "aside").map(([item]) => item);
  if (moved.length) {
    io.out(`  ! moved your own ${moved.join(", ")} to ${tildify(aside, env)}/ (merge by hand if useful; turno undo puts them back)`);
  }
}

const SEED_KEYS = ["mcpServers", "projects", "hasCompletedOnboarding", "lastOnboardingVersion", "theme"];

/** First .claude.json of a profile: user MCP servers and per-project state, never the account. */
function seedGlobalConfig(dir: string, io: Io, journal: Journal): void {
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
  writeOwn(dst, `${JSON.stringify(seed, null, 2)}\n`, journal);
  const count = (v: unknown) => (v && typeof v === "object" ? Object.keys(v).length : 0);
  io.out(`  + .claude.json with ${plural(count(seed.mcpServers), "MCP server")} and ${plural(count(seed.projects), "project")} from the hub`);
}

export interface SetupOptions {
  /** Shell words that run turno, baked into turno-auto and turno-open. */
  turno?: string;
  /** List every shared item instead of one summary line. */
  verbose?: boolean;
  /**
   * Records links, moves, folders, seeds and launchers. Without one, setupProfiles opens its
   * own ("profile repair ...") and prints its undo hint.
   */
  journal?: Journal;
}

/**
 * Codex profiles: seed config.toml from the hub once, and always store the login in the
 * profile (`cli_auth_credentials_store = "file"`), so each CODEX_HOME has its own account.
 */
function prepareCodex(dir: string, io: Io, journal: Journal): void {
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
    writeOwn(file, next, journal);
    io.out('  + cli_auth_credentials_store = "file" (the login stays in this profile)');
  }
  chmodSync(file, 0o600);
}

/** Profile of an agent other than Claude Code: its directory, hub links, config, launcher. */
function setupAgentProfile(name: string, agent: AgentId, io: Io, verbose: boolean, journal: Journal): void {
  const a = adapter(agent);
  const s = sharedItems(name, agent, io.env);
  const aside = join(s.dir, `.aside-${stamp()}`);
  profileFolder(s.dir, journal);
  const results: [string, Link][] = [];
  for (const item of s.dirs) {
    mkdirSync(join(s.hub, item), { recursive: true });
    results.push([item, linkItem(s.dir, item, aside, journal, s.hub)]);
  }
  for (const item of s.files) results.push([item, linkItem(s.dir, item, aside, journal, s.hub)]);
  reportLinks(name, ` (${a.label})`, s.dir, s.hub, results, aside, io, verbose);
  if (agent === "codex") prepareCodex(s.dir, io, journal);
  writeLauncher(name, io.env, agent, journal);
  io.out(`  + command ${launcherName(name, agent)}`);
}

export function setupProfiles(names: string[], io: Io, opts: SetupOptions = {}): void {
  if (names.length === 0) fail("usage: turno profile repair <profile>...");
  for (const name of names) checkName(name);
  // Launchers keep the path of this turno; a path into npx's cache disappears.
  if (opts.turno === undefined) refuseNpx();
  const turno = opts.turno !== undefined ? { words: opts.turno } : resolveTurnoCommand(io.env);
  const verbose = Boolean(opts.verbose);
  const p = paths(io.env);
  const config = loadConfig(io.env);
  const journal = opts.journal ?? new Journal(io.env, `profile repair ${names.join(" ")}`);
  for (const name of names) {
    const agent = agentOf(name, config);
    if (agent !== "claude") {
      setupAgentProfile(name, agent, io, verbose, journal);
      continue;
    }
    if (!existsSync(p.hub)) {
      // Claude Code creates it on first run; profiles need it now to link the shared folders.
      mkdirSync(p.hub, { recursive: true, mode: 0o700 });
      io.out(`  + created ${tildify(p.hub, io.env)} (the folder every Claude Code profile shares)`);
    }
    const s = sharedItems(name, "claude", io.env);
    const aside = join(s.dir, `.aside-${stamp()}`);
    profileFolder(s.dir, journal);
    const results: [string, Link][] = [];
    let busy = false;
    for (const item of s.dirs) {
      if (item === "sessions" && !lstat(join(s.dir, item))?.isSymbolicLink() && profileBusy(name, io.env, config)) {
        busy = true;
        continue;
      }
      mkdirSync(join(p.hub, item), { recursive: true });
      results.push([item, linkItem(s.dir, item, aside, journal, p.hub)]);
    }
    for (const item of s.files) results.push([item, linkItem(s.dir, item, aside, journal, p.hub)]);
    reportLinks(name, "", s.dir, s.hub, results, aside, io, verbose);
    if (busy) io.out("  ! sessions: this profile has open sessions; close them and run turno profile repair again");
    seedGlobalConfig(s.dir, io, journal);
    const history = join(s.dir, "history.jsonl");
    const hubHistory = join(p.hub, "history.jsonl");
    if (!existsSync(history) && lstat(hubHistory)?.isFile()) {
      journal.save(history);
      copyFileSync(hubHistory, history);
      chmodSync(history, 0o600);
      journal.settle(history);
      io.out("  + history.jsonl (initial copy; the ↑ history cannot be shared)");
    }
    writeLauncher(name, io.env, "claude", journal);
    io.out(`  + command claude-${name}`);
  }
  const written = writeHelperLaunchers(io.env, turno.words, journal);
  if (verbose) for (const w of written) io.out(`+ command ${w}`);
  if (turno.warning) io.out(`! turno-auto and turno-open: ${turno.warning}`);
  if (!opts.journal) {
    const hint = journal.hint();
    if (hint) io.out(hint);
  }
}

export const command: Command = {
  summary: "create or repair ~/.claude-<profile> and its claude-<profile> command",
  hidden: true,
  usage: [
    "Usage: turno profile repair <profile>...",
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

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SetupStep } from "../../agents/adapter.js";
import { type AgentId, DEFAULT_AGENT, adapter, agentHub, agentProfileDir } from "../../agents/index.js";
import { type Config, isValidProfileName, loadConfig } from "../../core/config.js";
import { Journal, stamp } from "../../core/journal.js";
import { tildify } from "../../core/paths.js";
import { agentOf } from "../../core/profiles.js";
import { profileBusy } from "../../core/sessions.js";
import { type Command, type Io, fail, plural } from "../io.js";
import { launcherName, refuseNpx, resolveTurnoCommand, writeHelperLaunchers, writeLauncher } from "../launchers.js";

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

/**
 * Create a profile folder (0700) through the journal, so undo removes it while it is empty, or
 * narrow an existing one to 0700, so undo puts its old mode back.
 */
function profileFolder(dir: string, journal: Journal): void {
  journal.mkdir(dir, 0o700);
  journal.chmod(dir, 0o700);
}

/** Write a file the setup creates or changes (seeds, agent config) through the journal. */
function writeOwn(file: string, text: string, journal: Journal): void {
  journal.save(file);
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
  journal.settle(file);
}

/** Shared items of a profile: its folder, the agent's hub, and the items linked from it (files only when they exist). */
function sharedItems(name: string, agent: AgentId, env: NodeJS.ProcessEnv): { dir: string; hub: string; dirs: string[]; files: string[] } {
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
 * Set up one profile: its folder (0700), the hub links, the agent's own steps (ADR 0032) and
 * its launcher. Local copies of shared items move to .aside-<stamp>/.
 */
function setupProfile(name: string, agent: AgentId, io: Io, verbose: boolean, journal: Journal, config: Config): void {
  const a = adapter(agent);
  const step: SetupStep = {
    name,
    dir: agentProfileDir(name, agent, io.env),
    hub: agentHub(agent, io.env),
    env: io.env,
    journal,
    out: (line) => io.out(line),
    writeOwn: (file, text) => writeOwn(file, text, journal),
    busy: () => profileBusy(name, io.env, config),
  };
  a.setup?.before?.(step);
  const s = sharedItems(name, agent, io.env);
  const aside = join(s.dir, `.aside-${stamp()}`);
  profileFolder(s.dir, journal);
  const results: [string, Link][] = [];
  const held: string[] = [];
  for (const item of s.dirs) {
    const why = a.setup?.hold?.(item, step);
    if (why) {
      held.push(why);
      continue;
    }
    mkdirSync(join(s.hub, item), { recursive: true });
    results.push([item, linkItem(s.dir, item, aside, journal, s.hub)]);
  }
  for (const item of s.files) results.push([item, linkItem(s.dir, item, aside, journal, s.hub)]);
  reportLinks(name, agent === DEFAULT_AGENT ? "" : ` (${a.label})`, s.dir, s.hub, results, aside, io, verbose);
  for (const why of held) io.out(`  ! ${why}`);
  a.setup?.after?.(step);
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
  const config = loadConfig(io.env);
  const journal = opts.journal ?? new Journal(io.env, `profile repair ${names.join(" ")}`);
  for (const name of names) setupProfile(name, agentOf(name, config), io, verbose, journal, config);
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

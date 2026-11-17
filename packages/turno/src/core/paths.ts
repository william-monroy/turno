import { accessSync, chmodSync, closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";

/**
 * Every path turno touches, derived from HOME and the XDG variables so tests can run
 * against a sandbox home. Call `paths()` each time instead of caching: tests change HOME.
 */
export interface Paths {
  home: string;
  /** Claude Code hub shared by every profile (default ~/.claude). */
  hub: string;
  /** Global config of the hub account (default ~/.claude.json). */
  hubConfig: string;
  /** Where launchers (claude-<profile>, turno-auto, turno-open) are written. */
  bin: string;
  config: string;
  configFile: string;
  mcpFile: string;
  accountsFile: string;
  state: string;
  data: string;
  usageDir: string;
  exhaustedDir: string;
  planDir: string;
  runDir: string;
  backupsDir: string;
  logsDir: string;
  auditLog: string;
  mcpdToken: string;
  mcpdPort: string;
  mcpdManaged: string;
  mcpdCacheDir: string;
  serversDir: string;
  browserDir: string;
  chromeProfilesDir: string;
  /** Legacy (bash claudio) config dir, read by `turno migrate`. */
  legacyConfig: string;
}

export function paths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.HOME || homedir();
  const config = env.TURNO_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "turno");
  const state = env.TURNO_STATE_DIR || join(env.XDG_STATE_HOME || join(home, ".local", "state"), "turno");
  const data = env.TURNO_DATA_DIR || join(env.XDG_DATA_HOME || join(home, ".local", "share"), "turno");
  return {
    home,
    hub: env.TURNO_HUB || join(home, ".claude"),
    hubConfig: env.TURNO_HUB_CONFIG || join(home, ".claude.json"),
    bin: env.TURNO_BIN || join(home, ".local", "bin"),
    config,
    configFile: join(config, "config.toml"),
    mcpFile: join(config, "mcp.toml"),
    accountsFile: join(config, "accounts.toml"),
    state,
    data,
    usageDir: join(state, "usage"),
    exhaustedDir: join(state, "exhausted"),
    planDir: join(state, "plan"),
    runDir: join(state, "run"),
    backupsDir: join(state, "backups"),
    logsDir: join(state, "logs"),
    auditLog: join(state, "audit.jsonl"),
    mcpdToken: join(state, "mcpd.token"),
    mcpdPort: join(state, "mcpd.port"),
    mcpdManaged: join(state, "mcp-managed.json"),
    mcpdCacheDir: join(data, "mcpd", "cache"),
    serversDir: join(data, "servers"),
    browserDir: join(data, "browser"),
    chromeProfilesDir: join(data, "chrome"),
    legacyConfig: join(home, ".config", "claudio"),
  };
}

/** Config dir of a profile: ~/.claude-<name>. */
export function profileDir(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(paths(env).home, `.claude-${name}`);
}

/** Replace the home prefix with ~ for display. */
export function tildify(p: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = paths(env).home;
  return p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** Expand a leading ~ to the home directory. */
export function expandHome(p: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = paths(env).home;
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/** Mode of every directory turno creates under its own config, state and data roots. */
export const PRIVATE_DIR_MODE = 0o700;
/** Mode of every file turno writes under those roots (logs, accounts.toml, audit log, mcpd.port). */
export const PRIVATE_FILE_MODE = 0o600;

/** turno's own roots (config, state, data): what `ensurePrivateDir` locks down. */
export function privateRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const p = paths(env);
  return [p.config, p.state, p.data];
}

function within(file: string, root: string): boolean {
  const rel = relative(root, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The turno root (config, state or data) that holds `file`, if any. */
function rootOf(file: string, env: NodeJS.ProcessEnv): string | undefined {
  return privateRoots(env).find((root) => within(file, root));
}

/** True when `file` is one of turno's roots or lies inside one. */
export function isPrivatePath(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return rootOf(file, env) !== undefined;
}

/** Roots already checked by this process (tests switch HOME, so the key is the path). */
const lockedRoots = new Set<string>();

function lockRoot(root: string): void {
  if (lockedRoots.has(root)) return;
  // Parents such as ~/.config keep the default mode; only turno's own folder is private.
  mkdirSync(dirname(root), { recursive: true });
  try {
    mkdirSync(root, { mode: PRIVATE_DIR_MODE });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const st = statSync(root);
  if ((st.mode & 0o777) !== PRIVATE_DIR_MODE && st.uid === process.getuid?.()) chmodSync(root, PRIVATE_DIR_MODE);
  lockedRoots.add(root);
}

/**
 * Create `dir` (and its parents) for turno's own state. Inside turno's config, state and data
 * roots every folder is created 0700, and an existing root with a wider mode is narrowed to
 * 0700 the first time a process uses it. Other folders are created with the default mode.
 * Returns `dir`.
 */
export function ensurePrivateDir(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = rootOf(dir, env);
  if (!root) {
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  lockRoot(root);
  // Recursive mkdir applies the mode to every folder it creates, the root included if it vanished.
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  return dir;
}

/**
 * Write a small file turno keeps for itself (a mark, a cache, a state file): its folder through
 * `ensurePrivateDir`, the file created 0600, and narrowed to 0600 when an older turno left it
 * wider. Not atomic; use the journal's `atomicWrite` for files a reader must never see half written.
 */
export function writePrivateFile(file: string, data: string, env: NodeJS.ProcessEnv = process.env): void {
  ensurePrivateDir(dirname(file), env);
  const fd = openSync(file, "w", PRIVATE_FILE_MODE);
  try {
    if (fstatSync(fd).mode & 0o077) fchmodSync(fd, PRIVATE_FILE_MODE);
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** Forget which roots were checked (tests). */
export function resetPrivateDirCache(): void {
  lockedRoots.clear();
}

/** The first executable called `name` on the PATH of `env`, or undefined. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (name.includes("/")) {
    try {
      accessSync(name, constants.X_OK);
      return name;
    } catch {
      return undefined;
    }
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {
      /* next */
    }
  }
  return undefined;
}

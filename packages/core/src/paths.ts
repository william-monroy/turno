import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";

/**
 * turno's own roots, derived from HOME and the XDG variables so tests can run against a
 * sandbox home. turno-cli and turno-browser both build their paths on these, so the two
 * packages always agree on where turno keeps its files. Call it each time instead of caching:
 * tests change HOME.
 */
export interface TurnoRoots {
  home: string;
  /** `TURNO_CONFIG_DIR`, else `$XDG_CONFIG_HOME/turno` (default `~/.config/turno`). */
  config: string;
  /** `TURNO_STATE_DIR`, else `$XDG_STATE_HOME/turno` (default `~/.local/state/turno`). */
  state: string;
  /** `TURNO_DATA_DIR`, else `$XDG_DATA_HOME/turno` (default `~/.local/share/turno`). */
  data: string;
}

export function turnoRoots(env: NodeJS.ProcessEnv = process.env): TurnoRoots {
  const home = env.HOME || homedir();
  return {
    home,
    config: env.TURNO_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "turno"),
    state: env.TURNO_STATE_DIR || join(env.XDG_STATE_HOME || join(home, ".local", "state"), "turno"),
    data: env.TURNO_DATA_DIR || join(env.XDG_DATA_HOME || join(home, ".local", "share"), "turno"),
  };
}

/** Where turno-browser keeps its files. */
export interface BrowserPaths {
  home: string;
  state: string;
  data: string;
  /** Root of the browser package data: <data>/browser. */
  browserDir: string;
  /** Persistent Chrome profiles, one per identity. */
  identitiesDir: string;
  /** Bench reports: <state>/bench. */
  benchDir: string;
  /** Generated files per identity, outside the Chrome profile: <state>/browser/identities. */
  identityStateDir: string;
}

export function browserPaths(env: NodeJS.ProcessEnv = process.env): BrowserPaths {
  const { home, state, data } = turnoRoots(env);
  const browserDir = join(data, "browser");
  return {
    home,
    state,
    data,
    browserDir,
    identitiesDir: join(browserDir, "identities"),
    benchDir: join(state, "bench"),
    identityStateDir: join(state, "browser", "identities"),
  };
}

/** Mode of every directory turno creates under its own config, state and data roots. */
export const PRIVATE_DIR_MODE = 0o700;
/** Mode of every file turno writes under those roots (logs, accounts.toml, audit log, mcpd.port). */
export const PRIVATE_FILE_MODE = 0o600;

/** turno's own roots (config, state, data): what `ensurePrivateDir` locks down. */
export function privateRoots(env: NodeJS.ProcessEnv): string[] {
  const r = turnoRoots(env);
  return [r.config, r.state, r.data];
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
export function isPrivatePath(file: string, env: NodeJS.ProcessEnv): boolean {
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
export function ensurePrivateDir(dir: string, env: NodeJS.ProcessEnv): string {
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
 * wider. Not atomic; write to a temporary name and rename for files a reader must never see
 * half written.
 */
export function writePrivateFile(file: string, data: string, env: NodeJS.ProcessEnv): void {
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
export function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
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

import { join } from "node:path";
import { browserPaths, turnoRoots } from "turno-core/paths";

// The roots, private folders and PATH lookup are shared with turno-browser.
export {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  ensurePrivateDir,
  findOnPath,
  isPrivatePath,
  privateRoots,
  resetPrivateDirCache,
  tildify,
  writePrivateFile,
} from "turno-core/paths";

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

export function paths(env: NodeJS.ProcessEnv): Paths {
  const { home, config, state, data } = turnoRoots(env);
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
    browserDir: browserPaths(env).browserDir,
    chromeProfilesDir: join(data, "chrome"),
    legacyConfig: join(home, ".config", "claudio"),
  };
}

/** Config dir of a profile: ~/.claude-<name>. */
export function profileDir(name: string, env: NodeJS.ProcessEnv): string {
  return join(paths(env).home, `.claude-${name}`);
}

/** Expand a leading ~ to the home directory. */
export function expandHome(p: string, env: NodeJS.ProcessEnv): string {
  const home = paths(env).home;
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

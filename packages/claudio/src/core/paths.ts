import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Every path claudio touches, derived from HOME and the XDG variables so tests can run
 * against a sandbox home. Call `paths()` each time instead of caching: tests change HOME.
 */
export interface Paths {
  home: string;
  /** Claude Code hub shared by every profile (default ~/.claude). */
  hub: string;
  /** Global config of the hub account (default ~/.claude.json). */
  hubConfig: string;
  /** Where launchers (claude-<profile>, claudio-auto, claudio-open) are written. */
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
  /** Legacy (bash claudio) config dir, read by `claudio migrate`. */
  legacyConfig: string;
}

export function paths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.HOME || homedir();
  const config = env.CLAUDIO_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "claudio");
  const state = env.CLAUDIO_STATE_DIR || join(env.XDG_STATE_HOME || join(home, ".local", "state"), "claudio");
  const data = env.CLAUDIO_DATA_DIR || join(env.XDG_DATA_HOME || join(home, ".local", "share"), "claudio");
  return {
    home,
    hub: env.CLAUDIO_HUB || join(home, ".claude"),
    hubConfig: env.CLAUDIO_HUB_CONFIG || join(home, ".claude.json"),
    bin: env.CLAUDIO_BIN || join(home, ".local", "bin"),
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
  return p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

/** Expand a leading ~ to the home directory. */
export function expandHome(p: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = paths(env).home;
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

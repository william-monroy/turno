import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentId } from "../agents/index.js";
import type { Config } from "./config.js";
import { isValidProfileName } from "./config.js";
import { paths, profileDir } from "./paths.js";

/** The agent a profile runs: from config.toml, else Claude Code. */
export function agentOf(name: string, config: Config): AgentId {
  return config.profiles[name]?.agent ?? "claude";
}

/**
 * A profile is a ~/.claude-<name> directory that has its claude-<name> launcher, or a
 * profile declared in config.toml (the only way for agents other than Claude Code). Other
 * folders matching the pattern (for example a place to keep shared skills) are not accounts.
 * With `agent`, only that agent's profiles.
 */
export function listProfiles(config: Config, env: NodeJS.ProcessEnv = process.env, agent?: AgentId): string[] {
  const p = paths(env);
  const found = new Set<string>(Object.keys(config.profiles));
  let entries: string[] = [];
  try {
    entries = readdirSync(p.home);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.startsWith(".claude-")) continue;
    const name = entry.slice(".claude-".length);
    if (!isValidProfileName(name)) continue;
    const dir = join(p.home, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(p.bin, `claude-${name}`))) found.add(name);
  }
  return [...found].filter((n) => !agent || agentOf(n, config) === agent).sort();
}

export function profileExists(name: string, config: Config, env: NodeJS.ProcessEnv = process.env): boolean {
  return listProfiles(config, env).includes(name);
}

/** The profile a CLAUDE_CONFIG_DIR value belongs to, or the system profile for the hub. */
export function profileFromConfigDir(
  configDir: string | undefined,
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const p = paths(env);
  const dir = (configDir ?? "").replace(/\/+$/, "");
  if (dir) {
    const base = dir.slice(dir.lastIndexOf("/") + 1);
    if (base.startsWith(".claude-")) return base.slice(".claude-".length);
    if (dir !== p.hub) return undefined;
  }
  return config.system;
}

export { profileDir };

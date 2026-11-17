import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type AgentId, adapter } from "../agents/index.js";
import type { Config } from "./config.js";
import { isValidProfileName, suggestKey } from "./config.js";
import { loadManifest } from "./manifest.js";
import { paths, profileDir, tildify } from "./paths.js";

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

/**
 * What is wrong in a config.toml that parses: unknown keys (likely typos) and names of
 * profiles that do not exist in system, default, fallback, [agents.*] and [[projects]].
 * Warnings, not errors, so an older or hand-edited file keeps working.
 */
export function configProblems(config: Config, env: NodeJS.ProcessEnv = process.env): string[] {
  const out = [...(config.warnings ?? [])];
  const known = new Set(listProfiles(config, env));
  const missing = (where: string, name: string | undefined) => {
    if (name && !known.has(name)) out.push(`${where} = "${name}", but there is no profile ${name} (turno profile list)`);
  };
  missing("system", config.system);
  missing("default", config.default);
  missing("fallback", config.fallback);
  for (const [id, roles] of Object.entries(config.agents)) {
    missing(`agents.${id}.default`, roles?.default);
    missing(`agents.${id}.fallback`, roles?.fallback);
    for (const role of ["default", "fallback"] as const) {
      const name = roles?.[role];
      if (name && known.has(name) && agentOf(name, config) !== id) out.push(`agents.${id}.${role} = "${name}", but ${name} is a ${adapter(agentOf(name, config)).label} profile`);
    }
  }
  for (const role of ["default", "fallback"] as const) {
    const name = config[role];
    if (name && known.has(name) && agentOf(name, config) !== "claude") out.push(`${role} = "${name}" is for Claude Code, but ${name} is a ${adapter(agentOf(name, config)).label} profile (use [agents.${agentOf(name, config)}])`);
  }
  for (const rule of config.projects) {
    if (rule.profile && !known.has(rule.profile)) out.push(`the rule for ${tildify(rule.path, env)} uses profile ${rule.profile}, which does not exist (turno profile list)`);
  }
  out.push(...folderSetProblems(config, env));
  return out;
}

/**
 * Folder server sets (ADR 0031) checked against mcp.toml: names it does not declare, and
 * remote servers that skip mcpd, which a set cannot hide. Nothing when mcp.toml is missing or
 * broken (its own check reports that).
 */
export function folderSetProblems(config: Config, env: NodeJS.ProcessEnv = process.env): string[] {
  const rules = config.projects.filter((r) => r.mcp || r.mcpDeny);
  if (!rules.length || !existsSync(paths(env).mcpFile)) return [];
  let servers;
  try {
    servers = loadManifest(env).servers;
  } catch {
    return [];
  }
  const declared = Object.keys(servers);
  const out: string[] = [];
  for (const rule of rules) {
    const where = `the rule for ${tildify(rule.path, env)}`;
    for (const [key, list] of [["mcp", rule.mcp], ["mcp_deny", rule.mcpDeny]] as const) {
      for (const name of list ?? []) {
        if (servers[name]) continue;
        const near = suggestKey(name, declared);
        out.push(`${where} lists "${name}" in ${key}, which is not in mcp.toml${near ? ` (did you mean ${near}?)` : " (turno mcp list)"}`);
      }
    }
    for (const [name, def] of Object.entries(servers)) {
      const hidden = (rule.mcp && !rule.mcp.includes(name)) || rule.mcpDeny?.includes(name);
      if (hidden && def.kind === "remote" && !def.proxy) out.push(`${where} cannot hide ${name}: it is a remote server that does not pass through mcpd`);
    }
  }
  return out;
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

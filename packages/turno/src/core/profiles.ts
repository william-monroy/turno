import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type AgentId, DEFAULT_AGENT, adapter } from "../agents/index.js";
import type { Config } from "./config.js";
import { isValidProfileName, suggestKey } from "./config.js";
import { loadManifest } from "./manifest.js";
import { paths, tildify } from "./paths.js";

/** The agent a profile runs: from config.toml, else Claude Code. */
export function agentOf(name: string, config: Config): AgentId {
  return config.profiles[name]?.agent ?? DEFAULT_AGENT;
}

/**
 * A profile is a ~/.claude-<name> directory that has its claude-<name> launcher, or a
 * profile declared in config.toml (the only way for agents other than Claude Code). Other
 * folders matching the pattern (for example a place to keep shared skills) are not accounts.
 * With `agent`, only that agent's profiles.
 */
export function listProfiles(config: Config, env: NodeJS.ProcessEnv, agent?: AgentId): string[] {
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

/** A problem in a config.toml that parses, and how to fix it (ADR 0035). */
export interface ConfigFinding {
  text: string;
  /** A command that fixes it. */
  hint?: string;
  /** The manual step: the line of config.toml to edit, when turno can find it. */
  manual?: string;
}

/**
 * What is wrong in a config.toml that parses: unknown keys (likely typos) and names of
 * profiles that do not exist in system, default, fallback, [agents.*] and [[projects]].
 * Warnings, not errors, so an older or hand-edited file keeps working. Each one says how to
 * fix it: `turno profile add <name>` for a missing profile, else the line to edit.
 */
export function configFindings(config: Config, env: NodeJS.ProcessEnv): ConfigFinding[] {
  const lines = configLines(env);
  const file = tildify(paths(env).configFile, env);
  /** "edit ~/.config/turno/config.toml line 3: <what>", or `turno config edit` without a line. */
  const edit = (key: string, what?: string): Pick<ConfigFinding, "hint" | "manual"> => {
    const line = lines ? keyLine(lines, key) : undefined;
    return line ? { manual: `edit ${file} line ${line}${what ? `: ${what}` : ""}` } : { hint: "turno config edit" };
  };
  const out: ConfigFinding[] = (config.warnings ?? []).map((text) => {
    const m = /^unknown key ([^\s;]+)(?: \(did you mean ([^\s?]+)\?\))?/.exec(text);
    return {
      text,
      ...(m
        ? edit(m[1]!, m[2] ? `rename it to ${m[2].slice(m[2].lastIndexOf(".") + 1)}` : "remove it")
        : { hint: "turno config edit" }),
    };
  });
  const known = new Set(listProfiles(config, env));
  const missing = (where: string, name: string | undefined) => {
    if (name && !known.has(name))
      out.push({ text: `${where} = "${name}", but there is no profile ${name}`, hint: `turno profile add ${name}` });
  };
  missing("system", config.system);
  missing("default", config.default);
  missing("fallback", config.fallback);
  for (const [id, roles] of Object.entries(config.agents)) {
    missing(`agents.${id}.default`, roles?.default);
    missing(`agents.${id}.fallback`, roles?.fallback);
    for (const role of ["default", "fallback"] as const) {
      const name = roles?.[role];
      if (name && known.has(name) && agentOf(name, config) !== id) {
        const label = adapter(id as AgentId).label;
        out.push({
          text: `agents.${id}.${role} = "${name}", but ${name} is a ${adapter(agentOf(name, config)).label} profile`,
          ...edit(`agents.${id}.${role}`, `name a ${label} profile`),
        });
      }
    }
  }
  for (const role of ["default", "fallback"] as const) {
    const name = config[role];
    if (name && known.has(name) && agentOf(name, config) !== DEFAULT_AGENT) {
      const other = agentOf(name, config);
      out.push({
        text: `${role} = "${name}" is for ${adapter(DEFAULT_AGENT).label}, but ${name} is a ${adapter(other).label} profile`,
        ...edit(role, `move it to [agents.${other}]`),
      });
    }
  }
  for (const [i, rule] of config.projects.entries()) {
    if (rule.profile && !known.has(rule.profile))
      out.push({
        text: `the rule for ${tildify(rule.path, env)} uses profile ${rule.profile}, which does not exist`,
        hint: `turno profile add ${rule.profile}`,
      });
    out.push(...folderSetFindings(rule, i, env, edit));
  }
  return out;
}

/** The findings as `config check` prints them: the command in parentheses, or the line to edit after it. */
export function configProblems(config: Config, env: NodeJS.ProcessEnv): string[] {
  return configFindings(config, env).map((f) => (f.manual ? `${f.text}; ${f.manual}` : `${f.text} (${f.hint})`));
}

/** The lines of config.toml, or undefined when it cannot be read. */
function configLines(env: NodeJS.ProcessEnv): string[] | undefined {
  try {
    return readFileSync(paths(env).configFile, "utf8").split("\n");
  } catch {
    return undefined;
  }
}

/**
 * The 1-based line of a dotted key in config.toml text: `default`, `profiles.work.colour`,
 * `agents.codex.default`, `projects[0].profile` (the first [[projects]] table). Tables and
 * array tables are followed; inline tables and dotted keys inside a table are not.
 */
function keyLine(lines: readonly string[], key: string): number | undefined {
  let table = "";
  const arrays = new Map<string, number>();
  const bare = (k: string) => k.trim().replace(/^"(.*)"$/, "$1");
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    const arr = /^\[\[\s*([^\]]+?)\s*\]\]/.exec(line);
    if (arr) {
      const name = arr[1]!.split(".").map(bare).join(".");
      const n = (arrays.get(name) ?? -1) + 1;
      arrays.set(name, n);
      table = `${name}[${n}]`;
      continue;
    }
    const tab = /^\[\s*([^\]]+?)\s*\]/.exec(line);
    if (tab) {
      table = tab[1]!.split(".").map(bare).join(".");
      continue;
    }
    const kv = /^("[^"]*"|[A-Za-z0-9_-]+)\s*=/.exec(line);
    if (kv && (table ? `${table}.${bare(kv[1]!)}` : bare(kv[1]!)) === key) return i + 1;
  }
  return undefined;
}

/**
 * Folder server sets (ADR 0031) checked against mcp.toml: names it does not declare, and
 * remote servers that skip mcpd, which a set cannot hide. Nothing when mcp.toml is missing or
 * broken (its own check reports that).
 */
function folderSetFindings(
  rule: Config["projects"][number],
  index: number,
  env: NodeJS.ProcessEnv,
  edit: (key: string, what?: string) => Pick<ConfigFinding, "hint" | "manual">,
): ConfigFinding[] {
  if ((!rule.mcp && !rule.mcpDeny) || !existsSync(paths(env).mcpFile)) return [];
  let servers;
  try {
    servers = loadManifest(env).servers;
  } catch {
    return [];
  }
  const declared = Object.keys(servers);
  const out: ConfigFinding[] = [];
  const where = `the rule for ${tildify(rule.path, env)}`;
  for (const [key, list] of [
    ["mcp", rule.mcp],
    ["mcp_deny", rule.mcpDeny],
  ] as const) {
    for (const name of list ?? []) {
      if (servers[name]) continue;
      const near = suggestKey(name, declared);
      out.push({
        text: `${where} lists "${name}" in ${key}, which is not in mcp.toml${near ? ` (did you mean ${near}?)` : ""}`,
        ...edit(`projects[${index}].${key}`, near ? `write ${near}` : `remove "${name}", or declare it in mcp.toml`),
      });
    }
  }
  for (const [name, def] of Object.entries(servers)) {
    const hidden = (rule.mcp && !rule.mcp.includes(name)) || rule.mcpDeny?.includes(name);
    if (hidden && def.kind === "remote" && !def.proxy) {
      const fix = rule.mcpDeny?.includes(name)
        ? edit(`projects[${index}].mcp_deny`, `remove ${name}`)
        : edit(`projects[${index}].mcp`, `add ${name}`);
      out.push({ text: `${where} cannot hide ${name}: it is a remote server that does not pass through mcpd`, ...fix });
    }
  }
  return out;
}

/** The profile a CLAUDE_CONFIG_DIR value belongs to, or the system profile for the hub. */
export function profileFromConfigDir(
  configDir: string | undefined,
  config: Config,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const p = paths(env);
  const dir = (configDir ?? "").replace(/\/+$/, "");
  if (dir) {
    const base = dir.slice(dir.lastIndexOf("/") + 1);
    if (base.startsWith(".claude-")) return base.slice(".claude-".length);
    if (dir !== p.hub) return undefined;
  }
  // system = "" says the hub is no profile's account.
  return config.system || undefined;
}

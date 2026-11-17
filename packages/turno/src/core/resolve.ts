import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import type { AgentId } from "../agents/index.js";
import type { Config, ProjectRule } from "./config.js";
import { exhaustedUntil } from "./exhausted.js";
import { tildify } from "./paths.js";
import { agentOf } from "./profiles.js";

export interface Resolution {
  /** Profile to launch now ("" means plain claude). */
  chosen: string;
  /** Profile assigned by the rules ("" when none). */
  assigned: string;
  reason: string;
  /** Set when the fallback replaced an exhausted profile. */
  note: string;
  /** Epoch seconds the assigned profile is exhausted until, when the fallback kicked in. */
  exhaustedUntil?: number;
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The directory itself plus, for a git worktree, the main repository it belongs to. */
export function candidateRoots(cwd: string): string[] {
  const cands = [real(cwd)];
  try {
    const common = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    if (common.endsWith("/.git")) {
      const main = real(common.slice(0, -5));
      if (!cands.includes(main)) cands.push(main);
    }
  } catch {
    // not a git repository
  }
  return cands;
}

export function formatUntil(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString("en-US", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** True when `folder` is `root` or inside it (both real paths). */
function covers(root: string, folder: string): boolean {
  return folder === root || folder.startsWith(root + sep);
}

/**
 * The MCP server set of a folder (ADR 0031): among the rules that have `mcp` or `mcp_deny` and
 * cover one of `roots` (the folder, and the main repository of a worktree), the one with the
 * longest path. On a tie, the rule of `profile`, else the first one in the file. A rule without
 * a set says nothing about servers, so a nested profile rule does not clear a parent's set.
 */
export function folderMcpSet(roots: string[], rules: ProjectRule[], profile?: string): ProjectRule | undefined {
  let best: { rule: ProjectRule; root: string } | undefined;
  for (const rule of rules) {
    if (!rule.mcp && !rule.mcpDeny) continue;
    const root = real(rule.path);
    if (!roots.some((c) => covers(root, c))) continue;
    const longer = !best || root.length > best.root.length;
    const preferred = best && root.length === best.root.length && profile !== undefined && rule.profile === profile && best.rule.profile !== profile;
    if (longer || preferred) best = { rule, root };
  }
  return best?.rule;
}

/** Whether a folder's set lets a session see `server` (no set: every server). */
export function mcpSetAllows(set: ProjectRule | undefined, server: string): boolean {
  if (!set) return true;
  if (set.mcp && !set.mcp.includes(server)) return false;
  return !set.mcpDeny?.includes(server);
}

/**
 * Which profile of `agent` a folder uses: the longest matching project rule among that agent's
 * profiles, else the agent's default; its fallback when the assigned profile is exhausted.
 */
export function resolveProfile(
  cwd: string,
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  roots: string[] = candidateRoots(cwd),
  agent: AgentId = "claude",
): Resolution {
  const roles = agent === "claude" ? { default: config.default, fallback: config.fallback } : (config.agents[agent] ?? {});
  let best: { profile: string; root: string } | undefined;
  for (const rule of config.projects) {
    if (!rule.profile || agentOf(rule.profile, config) !== agent) continue;
    const root = real(rule.path);
    const hit = roots.some((c) => covers(root, c));
    if (hit && (!best || root.length > best.root.length)) best = { profile: rule.profile, root };
  }
  const assigned = best ? best.profile : (roles.default ?? "");
  const reason = best ? `project ${tildify(best.root, env)}` : "folder without a rule";

  let chosen = assigned;
  let note = "";
  let until: number | undefined;
  if (assigned) {
    until = exhaustedUntil(assigned, env);
    const fallback = roles.fallback;
    if (until !== undefined && fallback && fallback !== assigned && exhaustedUntil(fallback, env) === undefined) {
      chosen = fallback;
      note = `exhausted until ${formatUntil(until)}`;
    } else {
      until = undefined;
    }
  }
  return { chosen, assigned, reason, note, ...(until !== undefined ? { exhaustedUntil: until } : {}) };
}

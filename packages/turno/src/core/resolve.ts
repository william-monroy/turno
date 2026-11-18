import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { type AgentId, DEFAULT_AGENT } from "../agents/index.js";
import type { Config, ProjectRule } from "./config.js";
import { exhaustedUntil } from "./exhausted.js";
import { tildify } from "./paths.js";
import { agentOf } from "./profiles.js";
import { realOr } from "./fsutil.js";

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

/** The directory itself plus, for a git worktree, the main repository it belongs to. */
export function candidateRoots(
  cwd: string,
  spawnGit: (cwd: string) => string | undefined = gitCommonDirBySpawn,
): string[] {
  const cands = [realOr(cwd)];
  const found = gitCommonDirOnDisk(cwd);
  const common = found === UNSURE ? spawnGit(cwd) : found;
  if (common?.endsWith("/.git")) {
    const main = realOr(common.slice(0, -5));
    if (!cands.includes(main)) cands.push(main);
  }
  return cands;
}

/** What `git rev-parse --git-common-dir` prints in `cwd`, or undefined outside a repository. */
function gitCommonDirBySpawn(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    return undefined; // not a git repository
  }
}

const UNSURE = Symbol("unsure");

/** Variables that change how git finds a repository: with any of them set, git itself decides. */
const GIT_DISCOVERY_VARS = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

function stat(p: string) {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

/**
 * The git common dir of `cwd` (real path), found the way git finds it but with the file system
 * only: walk up to the first `.git`, follow a `gitdir:` file (worktrees, submodules), then the
 * `commondir` file of a linked worktree. The status line and `turno auto` resolve a folder on
 * every run, and a `git` process costs more than the rest of the resolve. Undefined outside a
 * repository; UNSURE for anything unusual (git variables, another owner, a broken `.git`, a
 * missing HEAD), which `git rev-parse` then answers as before.
 */
function gitCommonDirOnDisk(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined | typeof UNSURE {
  if (GIT_DISCOVERY_VARS.some((k) => env[k] !== undefined)) return UNSURE;
  let dir = realOr(cwd);
  const start = stat(dir);
  if (!start?.isDirectory()) return UNSURE;
  for (;;) {
    const here = stat(dir);
    // git stops at a file system boundary.
    if (!here || here.dev !== start.dev) return undefined;
    const dotgit = join(dir, ".git");
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(dotgit);
    } catch {
      st = undefined;
    }
    if (st) return commonDirOf(dir, dotgit, st.isFile());
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function commonDirOf(dir: string, dotgit: string, isFile: boolean): string | typeof UNSURE {
  // git refuses a repository another user owns, unless safe.directory says otherwise.
  const uid = process.getuid?.();
  if (uid !== undefined && stat(dir)?.uid !== uid) return UNSURE;
  let gitdir = dotgit;
  try {
    if (isFile) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotgit, "utf8"));
      if (!m) return UNSURE;
      gitdir = resolve(dir, m[1]!);
    }
    if (!stat(join(gitdir, "HEAD"))?.isFile()) return UNSURE;
    let common = gitdir;
    const pointer = join(gitdir, "commondir");
    if (existsSync(pointer)) common = resolve(gitdir, readFileSync(pointer, "utf8").trim());
    if (!stat(join(common, "objects"))?.isDirectory()) return UNSURE;
    return realpathSync(common);
  } catch {
    return UNSURE;
  }
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
 * The MCP server set of a folder: among the rules that have `mcp` or `mcp_deny` and
 * cover one of `roots` (the folder, and the main repository of a worktree), the one with the
 * longest path. On a tie, the rule of `profile`, else the first one in the file. A rule without
 * a set says nothing about servers, so a nested profile rule does not clear a parent's set.
 */
export function folderMcpSet(roots: string[], rules: ProjectRule[], profile?: string): ProjectRule | undefined {
  let best: { rule: ProjectRule; root: string } | undefined;
  for (const rule of rules) {
    if (!rule.mcp && !rule.mcpDeny) continue;
    const root = realOr(rule.path);
    if (!roots.some((c) => covers(root, c))) continue;
    const longer = !best || root.length > best.root.length;
    const preferred =
      best &&
      root.length === best.root.length &&
      profile !== undefined &&
      rule.profile === profile &&
      best.rule.profile !== profile;
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
  env: NodeJS.ProcessEnv,
  roots: string[] = candidateRoots(cwd),
  agent: AgentId = DEFAULT_AGENT,
): Resolution {
  const roles =
    agent === DEFAULT_AGENT ? { default: config.default, fallback: config.fallback } : (config.agents[agent] ?? {});
  let best: { profile: string; root: string } | undefined;
  for (const rule of config.projects) {
    if (!rule.profile || agentOf(rule.profile, config) !== agent) continue;
    const root = realOr(rule.path);
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

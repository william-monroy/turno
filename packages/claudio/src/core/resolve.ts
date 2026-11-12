import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import type { Config } from "./config.js";
import { exhaustedUntil } from "./exhausted.js";
import { tildify } from "./paths.js";

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

/** Which profile a folder uses: the longest matching project rule, else the default; fallback when exhausted. */
export function resolveProfile(
  cwd: string,
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  roots: string[] = candidateRoots(cwd),
): Resolution {
  let best: { profile: string; root: string } | undefined;
  for (const rule of config.projects) {
    const root = real(rule.path);
    const hit = roots.some((c) => c === root || c.startsWith(root + sep));
    if (hit && (!best || root.length > best.root.length)) best = { profile: rule.profile, root };
  }
  const assigned = best ? best.profile : (config.default ?? "");
  const reason = best ? `project ${tildify(best.root, env)}` : "folder without a rule";

  let chosen = assigned;
  let note = "";
  let until: number | undefined;
  if (assigned) {
    until = exhaustedUntil(assigned, env);
    const fallback = config.fallback;
    if (until !== undefined && fallback && fallback !== assigned && exhaustedUntil(fallback, env) === undefined) {
      chosen = fallback;
      note = `exhausted until ${formatUntil(until)}`;
    } else {
      until = undefined;
    }
  }
  return { chosen, assigned, reason, note, ...(until !== undefined ? { exhaustedUntil: until } : {}) };
}

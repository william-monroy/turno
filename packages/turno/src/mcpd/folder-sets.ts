import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The folders a session's server set is matched against (ADR 0031): the session folder, and
 * for a git worktree the main repository it belongs to, the same candidates `turno auto` uses
 * for profile rules. Async (mcpd must not block on git) and cached for 10 s, because an agent
 * opens one session per server at the same time.
 */
const cache = new Map<string, { at: number; value: Promise<string[]> }>();

export function folderRoots(cwd: string, now = Date.now()): Promise<string[]> {
  const hit = cache.get(cwd);
  if (hit && now - hit.at < 10_000) return hit.value;
  if (cache.size > 500) cache.clear();
  const value = compute(cwd);
  cache.set(cwd, { at: now, value });
  return value;
}

async function compute(cwd: string): Promise<string[]> {
  const own = await realpath(cwd).catch(() => cwd);
  const out = [own];
  try {
    const { stdout } = await run("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", timeout: 3000 });
    const common = stdout.trim();
    if (common.endsWith("/.git")) {
      const main = await realpath(common.slice(0, -5)).catch(() => common.slice(0, -5));
      if (!out.includes(main)) out.push(main);
    }
  } catch {
    // not a git repository
  }
  return out;
}

import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { candidateRoots } from "../src/core/resolve.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "protocol.file.allow=always", "-C", cwd, ...args], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  });

/** What candidateRoots returned before it read .git files: always through `git rev-parse`. */
function viaGit(cwd: string): string[] {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const out = [real(cwd)];
  try {
    const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
    if (common.endsWith("/.git") && !out.includes(real(common.slice(0, -5)))) out.push(real(common.slice(0, -5)));
  } catch {
    /* not a repository */
  }
  return out;
}

/** candidateRoots with a spawn that records whether git had to run. */
function onDisk(cwd: string): { roots: string[]; spawned: boolean } {
  let spawned = false;
  const roots = candidateRoots(cwd, (dir) => {
    spawned = true;
    try {
      return git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
    } catch {
      return undefined;
    }
  });
  return { roots, spawned };
}

describe("candidateRoots without spawning git", () => {
  it("gives what git rev-parse gives for repositories, worktrees, submodules and plain folders", () => {
    const h = sb.home;
    mkdirSync(join(h, "repo/src/deep"), { recursive: true });
    git(join(h, "repo"), "init", "-q");
    git(join(h, "repo"), "commit", "-q", "--allow-empty", "-m", "first");
    git(join(h, "repo"), "worktree", "add", "-q", join(h, "wt"));
    mkdirSync(join(h, "wt/pkg"), { recursive: true });
    mkdirSync(join(h, "lib"));
    git(join(h, "lib"), "init", "-q");
    git(join(h, "lib"), "commit", "-q", "--allow-empty", "-m", "lib");
    git(join(h, "repo"), "submodule", "add", "-q", join(h, "lib"), "vendor/lib");
    mkdirSync(join(h, "plain/a"), { recursive: true });
    symlinkSync(join(h, "repo/src"), join(h, "link"));
    // A repository whose .git folder is a link to where it really lives.
    mkdirSync(join(h, "moved"));
    git(join(h, "moved"), "init", "-q");
    renameSync(join(h, "moved/.git"), join(h, "moved.git"));
    symlinkSync(join(h, "moved.git"), join(h, "moved/.git"));

    const cases = ["repo", "repo/src/deep", "repo/.git", "repo/.git/refs", "wt", "wt/pkg", "repo/vendor/lib", "plain/a", "link", "moved", "lib"];
    for (const rel of cases) {
      const dir = join(h, rel);
      const got = onDisk(dir);
      expect(got.roots, rel).toEqual(viaGit(dir));
      expect(got.spawned, rel).toBe(false);
    }
    expect(onDisk(join(h, "wt/pkg")).roots).toEqual([realpathSync(join(h, "wt/pkg")), realpathSync(join(h, "repo"))]);
    // A submodule is its own project: no second root.
    expect(onDisk(join(h, "repo/vendor/lib")).roots).toHaveLength(1);
  });

  it("asks git when a .git file is broken, and agrees with it", () => {
    mkdirSync(join(sb.home, "odd/inner"), { recursive: true });
    writeFileSync(join(sb.home, "odd/.git"), "not a gitdir line\n");
    const got = onDisk(join(sb.home, "odd/inner"));
    expect(got.spawned).toBe(true);
    expect(got.roots).toEqual(viaGit(join(sb.home, "odd/inner")));
    mkdirSync(join(sb.home, "gone"));
    writeFileSync(join(sb.home, "gone/.git"), `gitdir: ${join(sb.home, "nowhere/.git/worktrees/x")}\n`);
    expect(onDisk(join(sb.home, "gone"))).toEqual({ roots: viaGit(join(sb.home, "gone")), spawned: true });
  });

  it("leaves a folder that does not exist to git, as before", () => {
    const missing = join(sb.home, "missing");
    expect(onDisk(missing)).toEqual({ roots: [missing], spawned: true });
  });
});

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authStatus } from "../src/cli/commands/usage.js";
import { compileCacheDir } from "../src/cli/compile-cache.js";
import { main } from "../src/cli/main.js";
import { COMMANDS, HELP_SUMMARY, visibleCommands } from "../src/cli/registry.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_MAIN = join(PKG, "dist/cli/main.js");
const BUILT = existsSync(join(PKG, "dist/cli/compile-cache.js"));

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

describe("help from static data", () => {
  it("has a summary for every visible command, equal to the command's own", async () => {
    for (const name of visibleCommands()) {
      const { command } = await COMMANDS[name]!();
      expect(HELP_SUMMARY[name], name).toBe(command.summary);
    }
  });

  it("loads no command module for turno --help, -h or help", async () => {
    const loaded: string[] = [];
    const originals = { ...COMMANDS };
    for (const [name, load] of Object.entries(originals)) {
      COMMANDS[name] = () => {
        loaded.push(name);
        return load();
      };
    }
    try {
      for (const args of [["--help"], ["-h"], ["help"]]) {
        const io = fakeIo(sb.env);
        expect(await main(args, io)).toBe(0);
        const text = io.lines.join("\n");
        for (const name of visibleCommands()) expect(text).toContain(HELP_SUMMARY[name]!.slice(0, 30));
      }
      expect(loaded).toEqual([]);
    } finally {
      Object.assign(COMMANDS, originals);
    }
  });
});

describe("compile cache", () => {
  it("lives in the user cache dir", () => {
    expect(compileCacheDir({ HOME: "/h" })).toBe("/h/.cache/turno/node-compile-cache");
    expect(compileCacheDir({ HOME: "/h", XDG_CACHE_HOME: "/c" })).toBe("/c/turno/node-compile-cache");
  });

  const run = (env: NodeJS.ProcessEnv) => {
    const clean = { ...sb.env, ...env };
    for (const k of ["NODE_COMPILE_CACHE", "NODE_DISABLE_COMPILE_CACHE"]) if (!(k in env)) delete clean[k];
    return spawnSync(process.execPath, [DIST_MAIN, "--version"], { env: clean, encoding: "utf8" });
  };

  it.skipIf(!BUILT)("is written under ~/.cache/turno by the built CLI, and nowhere else in HOME", () => {
    const r = run({});
    expect(r.status).toBe(0);
    expect(readdirSync(sb.home)).toEqual([".cache"]);
    expect(readdirSync(join(sb.home, ".cache"))).toEqual(["turno"]);
    expect(readdirSync(join(sb.home, ".cache/turno/node-compile-cache")).length).toBeGreaterThan(0);
  });

  it.skipIf(!BUILT)("follows XDG_CACHE_HOME, and NODE_DISABLE_COMPILE_CACHE turns it off", () => {
    const xdg = join(sb.home, "xdg-cache");
    expect(run({ XDG_CACHE_HOME: xdg }).status).toBe(0);
    expect(readdirSync(join(xdg, "turno/node-compile-cache")).length).toBeGreaterThan(0);
    expect(existsSync(join(sb.home, ".cache"))).toBe(false);

    const off = join(sb.home, "off");
    expect(run({ XDG_CACHE_HOME: off, NODE_DISABLE_COMPILE_CACHE: "1" }).status).toBe(0);
    expect(existsSync(off)).toBe(false);
  });

  it.skipIf(!BUILT)("is off for turno demo, which leaves HOME as it found it", () => {
    for (const args of [
      ["demo", "--help"],
      ["--no-input", "demo", "--help"],
    ]) {
      const r = spawnSync(process.execPath, [DIST_MAIN, ...args], { env: sb.env, encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(readdirSync(sb.home)).toEqual([]);
    }
  });

  it("is listed by turno uninstall as something that stays", async () => {
    mkdirSync(join(sb.home, ".cache/turno/node-compile-cache"), { recursive: true });
    const io = fakeIo(sb.env);
    await main(["uninstall", "--dry-run"], io);
    expect(io.lines.join("\n")).toContain("~/.cache/turno (compiled code, safe to delete) stays");
  });
});

describe("claude auth status cache", () => {
  const LOGGED_IN = '{"loggedIn":true,"email":"alice@example.com","subscriptionType":"max"}';
  let calls: string;
  beforeEach(() => {
    calls = join(sb.home, "claude-calls");
    mkdirSync(join(sb.home, ".claude-work"));
  });
  const fake = (answer: string) => fakeCommand(sb, "claude", `echo x >> "${calls}"\necho '${answer}'`);
  const count = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0);
  const cacheFile = () => join(sb.home, ".local/state/turno/cache/auth-work.json");

  it("asks claude once while the profile's login files stay the same", async () => {
    fake(LOGGED_IN);
    expect((await authStatus("work", sb.env))?.email).toBe("alice@example.com");
    expect((await authStatus("work", sb.env))?.email).toBe("alice@example.com");
    expect(count()).toBe(1);
    expect(readFileSync(join(sb.home, ".local/state/turno/plan/work"), "utf8")).toBe("max\n");
  });

  it("asks again after a login or logout rewrites .claude.json or .credentials.json", async () => {
    fake('{"loggedIn":false}');
    expect((await authStatus("work", sb.env))?.loggedIn).toBe(false);
    fake(LOGGED_IN);
    writeFileSync(join(sb.home, ".claude-work/.claude.json"), '{"oauthAccount":{}}');
    expect((await authStatus("work", sb.env))?.loggedIn).toBe(true);
    fake('{"loggedIn":false}');
    writeFileSync(join(sb.home, ".claude-work/.credentials.json"), "{}");
    expect((await authStatus("work", sb.env))?.loggedIn).toBe(false);
    expect(count()).toBe(3);
  });

  it("asks again once the answer is five minutes old, and never keeps a failure", async () => {
    fake(LOGGED_IN);
    await authStatus("work", sb.env);
    const entry = JSON.parse(readFileSync(cacheFile(), "utf8")) as { at: number };
    writeFileSync(cacheFile(), JSON.stringify({ ...entry, at: entry.at - 301 }));
    await authStatus("work", sb.env);
    expect(count()).toBe(2);

    fakeCommand(sb, "claude", `echo x >> "${calls}"\nexit 1`);
    writeFileSync(join(sb.home, ".claude-work/.claude.json"), "{}");
    expect(await authStatus("work", sb.env)).toBeUndefined();
    expect(await authStatus("work", sb.env)).toBeUndefined();
    expect(count()).toBe(4);
  });
});

import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browserPaths, ensurePrivateDir, findOnPath, isPrivatePath, resetPrivateDirCache, turnoRoots, writePrivateFile } from "../src/paths.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  resetPrivateDirCache();
});
afterEach(() => sb.cleanup());

describe("turno's roots", () => {
  it("follow HOME, then XDG, then the TURNO_* overrides", () => {
    expect(turnoRoots({ HOME: "/h" })).toEqual({
      home: "/h",
      config: "/h/.config/turno",
      state: "/h/.local/state/turno",
      data: "/h/.local/share/turno",
    });
    expect(turnoRoots({ HOME: "/h", XDG_CONFIG_HOME: "/x/c", XDG_STATE_HOME: "/x/s", XDG_DATA_HOME: "/x/d" })).toMatchObject({
      config: "/x/c/turno",
      state: "/x/s/turno",
      data: "/x/d/turno",
    });
    expect(turnoRoots({ HOME: "/h", XDG_DATA_HOME: "/x/d", TURNO_DATA_DIR: "/t/d", TURNO_STATE_DIR: "/t/s", TURNO_CONFIG_DIR: "/t/c" })).toMatchObject({
      config: "/t/c",
      state: "/t/s",
      data: "/t/d",
    });
  });

  it("place turno-browser's files under the data and state roots", () => {
    expect(browserPaths({ HOME: "/h" })).toEqual({
      home: "/h",
      state: "/h/.local/state/turno",
      data: "/h/.local/share/turno",
      browserDir: "/h/.local/share/turno/browser",
      identitiesDir: "/h/.local/share/turno/browser/identities",
      benchDir: "/h/.local/state/turno/bench",
      identityStateDir: "/h/.local/state/turno/browser/identities",
    });
  });
});

describe("private files", () => {
  it("creates folders 0700 and files 0600 inside turno's roots only", () => {
    const file = join(turnoRoots(sb.env).state, "a", "b.json");
    writePrivateFile(file, "{}", sb.env);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(turnoRoots(sb.env).state, "a")).mode & 0o777).toBe(0o700);
    expect(statSync(turnoRoots(sb.env).state).mode & 0o777).toBe(0o700);
    expect(isPrivatePath(file, sb.env)).toBe(true);
    const outside = ensurePrivateDir(join(sb.home, "elsewhere"), sb.env);
    expect(isPrivatePath(outside, sb.env)).toBe(false);
  });
});

describe("findOnPath", () => {
  it("finds an executable on PATH and nothing else", () => {
    sb.write("bin/tool", "#!/bin/sh\n", 0o755);
    sb.write("bin/data", "x", 0o644);
    const env = { PATH: `${join(sb.home, "missing")}:${join(sb.home, "bin")}` };
    expect(findOnPath("tool", env)).toBe(join(sb.home, "bin", "tool"));
    expect(findOnPath("data", env)).toBeUndefined();
    expect(findOnPath(join(sb.home, "bin", "tool"), {})).toBe(join(sb.home, "bin", "tool"));
  });
});

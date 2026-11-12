import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The subset of claudio's paths this package needs, derived from HOME and the XDG variables
 * exactly like `claudio/src/core/paths.ts`. A local copy keeps this package free of a
 * dependency cycle with the CLI. Call it each time: tests change HOME.
 */
export interface BrowserPaths {
  home: string;
  state: string;
  data: string;
  /** Root of the browser package data: <data>/browser. */
  browserDir: string;
  /** Persistent Chrome profiles, one per identity. */
  identitiesDir: string;
  /** Bench reports: <state>/bench. */
  benchDir: string;
}

export function paths(env: NodeJS.ProcessEnv = process.env): BrowserPaths {
  const home = env.HOME || homedir();
  const state = env.CLAUDIO_STATE_DIR || join(env.XDG_STATE_HOME || join(home, ".local", "state"), "claudio");
  const data = env.CLAUDIO_DATA_DIR || join(env.XDG_DATA_HOME || join(home, ".local", "share"), "claudio");
  const browserDir = join(data, "browser");
  return {
    home,
    state,
    data,
    browserDir,
    identitiesDir: join(browserDir, "identities"),
    benchDir: join(state, "bench"),
  };
}

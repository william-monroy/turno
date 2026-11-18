import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The subset of turno's paths this package needs, derived from HOME and the XDG variables
 * exactly like `turno/src/core/paths.ts`. A local copy keeps this package free of a
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
  /** Generated files per identity, outside the Chrome profile: <state>/browser/identities. */
  identityStateDir: string;
}

export function paths(env: NodeJS.ProcessEnv = process.env): BrowserPaths {
  const home = env.HOME || homedir();
  const state = env.TURNO_STATE_DIR || join(env.XDG_STATE_HOME || join(home, ".local", "state"), "turno");
  const data = env.TURNO_DATA_DIR || join(env.XDG_DATA_HOME || join(home, ".local", "share"), "turno");
  const browserDir = join(data, "browser");
  return {
    home,
    state,
    data,
    browserDir,
    identitiesDir: join(browserDir, "identities"),
    benchDir: join(state, "bench"),
    identityStateDir: join(state, "browser", "identities"),
  };
}

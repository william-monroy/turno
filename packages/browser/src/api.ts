import { ENGINES, engineId, formatBenchTable, runBench } from "./bench.js";
import { runDoctor } from "./doctor.js";
import { readHealth } from "./health.js";
import { addIdentity, identityExists, inUseBy, isInUse, listIdentities, removeIdentity } from "./identities.js";
import { assertIdentityId, identityDir } from "./ids.js";
import { loginIdentity } from "./login.js";
import { reputationReport } from "./reputation.js";
import { checkIdentitySettings, identitySettingsPath, writeIdentitySettings } from "./settings.js";
import { manifestSnippet } from "./snippet.js";

/**
 * The contract between turno-browser and turno-cli (ADR 0047). turno-cli installs this package
 * apart, types it with `import type` (erased at build, so the package stays optional) and,
 * when it loads it, compares `API_VERSION` with the version it was built against:
 *
 * - `minor` goes up when a member is added; a CLI that needs the new member refuses an older
 *   package with one message that says to update it.
 * - `major` goes up when a member is removed or renamed, or its arguments, result or meaning
 *   change; an older CLI then refuses this package and says to update turno.
 *
 * `test/api.test.ts` lists the members, so a change here cannot ship without the version.
 */
export const API_VERSION = Object.freeze({ major: 1, minor: 0 } as const);

/** What `API_VERSION` looks like to a reader that does not know this package's version. */
export interface ApiVersion {
  readonly major: number;
  readonly minor: number;
}

/** The functions turno-cli calls: identities, their settings, login, doctor, reputation and bench. */
export const api = Object.freeze({
  ENGINES,
  engineId,
  listIdentities,
  addIdentity,
  removeIdentity,
  identityExists,
  identityDir,
  identitySettingsPath,
  isInUse,
  inUseBy,
  assertIdentityId,
  manifestSnippet,
  loginIdentity,
  checkIdentitySettings,
  writeIdentitySettings,
  readHealth,
  runDoctor,
  reputationReport,
  runBench,
  formatBenchTable,
});

export type BrowserApi = typeof api;

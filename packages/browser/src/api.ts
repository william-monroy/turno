import { ENGINES, engineId, formatBenchTable, runBench } from "./bench.js";
import { runDoctor } from "./doctor.js";
import { readHealth } from "./health.js";
import { addIdentity, identityExists, inUseBy, isInUse, listIdentities, removeIdentity } from "./identities.js";
import { assertIdentityId, identityDir } from "./ids.js";
import { loginIdentity } from "./login.js";
import { reputationReport } from "./reputation.js";
import { exportSession, importSession, readSessionExport } from "./session-export.js";
import { flowsDir, listFlows, readFlow, removeFlow } from "./flows.js";
import { listRecordings, openTraceViewer, recordingsDir, traceViewerCommand } from "./recordings.js";
import { replayFlow } from "./replay.js";
import { parseTotpSecret } from "./totp.js";
import { vaultAdd, vaultClear, vaultList, vaultRemove, vaultSetSubmit } from "./vault.js";
import { checkIdentitySettings, identitySettingsPath, writeIdentitySettings } from "./settings.js";
import { manifestSnippet } from "./snippet.js";

/**
 * The contract between turno-browser and turno-cli. turno-cli installs this package
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
export const API_VERSION = Object.freeze({ major: 1, minor: 7 } as const);

/** What `API_VERSION` looks like to a reader that does not know this package's version. */
export interface ApiVersion {
  readonly major: number;
  readonly minor: number;
}

/**
 * The functions turno-cli calls: identities, their settings, login, doctor, reputation, bench
 * (1.1) the credential vault, (1.2) session export and import, (1.3) the `humanize` key of
 * identity.json (no new member: `writeIdentitySettings` accepts it, an older package refuses it)
 * (1.4) the `sharing` key of identity.json and `manifestSnippet(id, { sharing })`, (1.5) the
 * `engine` and `attach` keys of identity.json and the engine checks of `runDoctor`, (1.6) the
 * `record` key of identity.json, saved flows, replay and recordings, and (1.7) the `act` and
 * `captcha` keys of identity.json (no new member) and `solved` in each site of
 * `reputationReport`.
 */
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
  vaultAdd,
  vaultList,
  vaultRemove,
  vaultClear,
  vaultSetSubmit,
  parseTotpSecret,
  exportSession,
  readSessionExport,
  importSession,
  flowsDir,
  listFlows,
  readFlow,
  removeFlow,
  replayFlow,
  listRecordings,
  recordingsDir,
  traceViewerCommand,
  openTraceViewer,
});

export type BrowserApi = typeof api;

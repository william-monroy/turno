import { fileURLToPath } from "node:url";
import { assertIdentityId } from "./ids.js";

export {
  IdentityError,
  type IdentityInfo,
  addIdentity,
  assertIdentityId,
  identityDir,
  identityExists,
  identityStateDir,
  inUseBy,
  isInUse,
  isValidIdentityId,
  listIdentities,
  parseSingletonLock,
  removeIdentity,
} from "./identities.js";
export {
  type HealthCheck,
  IDENTITY_FORMAT_VERSION,
  type IdentitySettings,
  type SettingsPatch,
  checkIdentitySettings,
  identitySettingsPath,
  readIdentitySettings,
  systemTimezone,
  writeIdentitySettings,
} from "./settings.js";
export { IdentityInUseError, type RuntimeLock, readRuntimeLock, runtimeLockAlive, runtimeLockPath } from "./runtime-lock.js";
export { type HealthRecord, readHealth } from "./health.js";
export { type ChallengeEvent, type IdentityReputation, type SiteSummary, readChallenges, reputationReport } from "./reputation.js";
export { type ChromeInfo, type DoctorCheck, type DoctorOptions, type DoctorReport, findChrome, runDoctor } from "./doctor.js";
export { type BuiltArgv, type PlaywrightMcpConfig, buildArgv, extractIdentity } from "./argv.js";
export {
  type BenchOptions,
  type BenchReport,
  DETECTORS,
  ENGINES,
  ENGINE_ALIASES,
  type EngineName,
  type EngineReport,
  type TargetResult,
  defaultEngines,
  engineId,
  formatBenchTable,
  runBench,
  unavailableReason,
} from "./bench.js";
export { CHALLENGE_MARKERS, type ChallengeKind, classifyChallenge, detectChallenge, parseRebrowser, parseSannysoft } from "./detectors.js";
export { type LoginOptions, loginIdentity } from "./login.js";
export { mcpEntryPath } from "./patchright.js";
export { paths } from "./paths.js";

/** Absolute path of the `turno-browser-mcp` executable script of this install. */
export function mcpBinPath(): string {
  return fileURLToPath(new URL("./bin/mcp.js", import.meta.url));
}

/** The mcp.toml block that serves one identity through mcpd (one session at a time). */
export function manifestSnippet(id: string): string {
  assertIdentityId(id);
  return [
    `[server.browser-${id}]`,
    `command = "turno-browser-mcp"`,
    `args = ["--identity", "${id}"]`,
    `scope = "shared"`,
    `exclusive = true`,
    `lease = "10m"`,
    `idle = "30m"`,
    "",
  ].join("\n");
}

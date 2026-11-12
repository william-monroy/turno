import { fileURLToPath } from "node:url";
import { assertIdentityId } from "./identities.js";

export {
  IdentityError,
  type IdentityInfo,
  addIdentity,
  assertIdentityId,
  identityDir,
  identityExists,
  isInUse,
  isValidIdentityId,
  listIdentities,
  parseSingletonLock,
  removeIdentity,
} from "./identities.js";
export { type BuiltArgv, buildArgv, extractIdentity } from "./argv.js";
export {
  type BenchOptions,
  type BenchReport,
  DETECTORS,
  ENGINES,
  type EngineName,
  type EngineReport,
  type TargetResult,
  defaultEngines,
  formatBenchTable,
  runBench,
  unavailableReason,
} from "./bench.js";
export { CHALLENGE_MARKERS, detectChallenge, parseRebrowser, parseSannysoft } from "./detectors.js";
export { type LoginOptions, loginIdentity } from "./login.js";
export { mcpEntryPath } from "./patchright.js";
export { paths } from "./paths.js";

/** Absolute path of the `claudio-browser-mcp` executable script of this install. */
export function mcpBinPath(): string {
  return fileURLToPath(new URL("./bin/mcp.js", import.meta.url));
}

/** The mcp.toml block that serves one identity through mcpd (one session at a time). */
export function manifestSnippet(id: string): string {
  assertIdentityId(id);
  return [
    `[server.browser-${id}]`,
    `command = "claudio-browser-mcp"`,
    `args = ["--identity", "${id}"]`,
    `scope = "shared"`,
    `exclusive = true`,
    `lease = "10m"`,
    `idle = "30m"`,
    "",
  ].join("\n");
}

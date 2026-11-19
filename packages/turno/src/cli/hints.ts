/**
 * The next step after a command that writes (turno-core's `nextStep`), on unless config.toml
 * says `hints = false`.
 */
import { nextStep as printNext } from "turno-core/cli/hints";
import { loadConfig } from "../core/config.js";
import type { Io } from "./io.js";

/** Whether hints are on: config.toml's `hints`, true when the file is missing or does not parse. */
export function hintsOn(env: NodeJS.ProcessEnv): boolean {
  try {
    return loadConfig(env).hints;
  } catch {
    return true;
  }
}

/**
 * Print `Next: <steps joined by "; ">`. `stream: "err"` keeps stdout clean for commands whose
 * stdout is a file (`turno mcp export > file.toml`).
 */
export function nextStep(
  io: Io,
  steps: string | readonly string[],
  opts: { json?: boolean; stream?: "out" | "err" } = {},
): void {
  printNext(io, steps, { ...opts, enabled: hintsOn });
}

/**
 * The next step after a command that writes: one `Next: ...` line, so a person knows what to run
 * after `profile add`, `mcp import --write` and the like. `hints = false` in config.toml turns
 * them off; they are never printed under --json, where stdout is data.
 */
import { loadConfig } from "../core/config.js";
import type { Io } from "./io.js";

/** Whether hints are on: config.toml's `hints`, true when the file is missing or does not parse. */
function hintsOn(env: NodeJS.ProcessEnv): boolean {
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
  const list = (typeof steps === "string" ? [steps] : steps).filter(Boolean);
  if (!list.length || opts.json || !hintsOn(io.env)) return;
  const line = `Next: ${list.join("; ")}`;
  if (opts.stream === "err") io.err(line);
  else io.out(line);
}

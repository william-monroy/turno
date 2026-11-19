/**
 * The next step after a command that writes: one `Next: ...` line, so a person knows what to run
 * after `profile add`, `mcp import --write` and the like. They are never printed under --json,
 * where stdout is data. Whether hints are on is the caller's setting (`hints = false` in turno's
 * config.toml turns them off), passed as `enabled`.
 */
import type { Io } from "./io.js";

/**
 * Print `Next: <steps joined by "; ">`. `stream: "err"` keeps stdout clean for commands whose
 * stdout is a file (`turno mcp export > file.toml`). `enabled` is read only when there is a line
 * to print.
 */
export function nextStep(
  io: Io,
  steps: string | readonly string[],
  opts: { json?: boolean; stream?: "out" | "err"; enabled?: boolean | ((env: NodeJS.ProcessEnv) => boolean) } = {},
): void {
  const list = (typeof steps === "string" ? [steps] : steps).filter(Boolean);
  if (!list.length || opts.json) return;
  const on = typeof opts.enabled === "function" ? opts.enabled(io.env) : (opts.enabled ?? true);
  if (!on) return;
  const line = `Next: ${list.join("; ")}`;
  if (opts.stream === "err") io.err(line);
  else io.out(line);
}

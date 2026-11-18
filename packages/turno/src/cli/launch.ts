import { spawn } from "node:child_process";
import { constants } from "node:os";
import { join } from "node:path";
import type { AgentId } from "../agents/index.js";
import { isValidProfileName, loadConfig } from "../core/config.js";
import { paths, tildify } from "../core/paths.js";
import { listProfiles } from "../core/profiles.js";
import { CliError, type Io, UsageError } from "./io.js";
import { executable, launcherName, profileAgent } from "./launchers.js";

export { findOnPath } from "./launchers.js";

/** Path of a profile's launcher (claude-<name>, codex-<name>, ...) when it exists and is executable. */
export function launcherPath(name: string, env: NodeJS.ProcessEnv = process.env, agent: AgentId = profileAgent(name, env)): string | undefined {
  if (!isValidProfileName(name)) return undefined;
  const file = join(paths(env).bin, launcherName(name, agent));
  return executable(file) ? file : undefined;
}

/** `--no-gateway` before any `--`, or TURNO_SAFE on: safe mode (cli/safe.ts holds the rest). */
export function wantsSafe(args: readonly string[], env: NodeJS.ProcessEnv): boolean {
  const end = args.indexOf("--");
  if ((end < 0 ? args : args.slice(0, end)).includes("--no-gateway")) return true;
  const v = env.TURNO_SAFE;
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/** Terminal signals already reach the child (same process group); these are passed on. */
const FORWARDED: NodeJS.Signals[] = ["SIGTERM", "SIGHUP"];
const IGNORED: NodeJS.Signals[] = ["SIGINT", "SIGQUIT"];

/**
 * Replace this process with `file args...` (the PID is kept, which run records rely on).
 * Without `process.execve` (Node < 22.15) the program runs as a child with inherited stdio,
 * and its exit code or signal is passed on.
 */
export async function execLauncher(file: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (typeof process.execve === "function") {
    process.execve(file, [file, ...args], env);
  }
  return new Promise<number>((resolve, reject) => {
    const child = spawn(file, args, { stdio: "inherit", env });
    const forward = (sig: NodeJS.Signals) => {
      child.kill(sig);
    };
    const ignore = () => {};
    for (const sig of FORWARDED) process.on(sig, forward);
    for (const sig of IGNORED) process.on(sig, ignore);
    const cleanup = () => {
      for (const sig of FORWARDED) process.off(sig, forward);
      for (const sig of IGNORED) process.off(sig, ignore);
    };
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("exit", (code, signal) => {
      cleanup();
      if (signal) {
        process.kill(process.pid, signal);
        resolve(128 + (constants.signals[signal] ?? 1));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

/**
 * `turno <profile> [args]`: exec the profile's launcher. `--no-gateway` among turno's arguments,
 * or TURNO_SAFE=1, opens it in safe mode instead (cli/safe.ts).
 */
export async function launchProfile(name: string, given: string[], io: Io): Promise<number> {
  let args = given;
  // Checked here without loading safe.ts, so a normal launch pays nothing for it.
  if (wantsSafe(given, io.env)) {
    const { launchSafe, takeSafeFlag } = await import("./safe.js");
    args = takeSafeFlag(given).args;
    if (!isValidProfileName(name)) throw new UsageError(`unknown command '${name}' (turno --help)`);
    let config;
    try {
      config = loadConfig(io.env);
    } catch (err) {
      throw new CliError((err as Error).message);
    }
    if (!listProfiles(config, io.env).includes(name)) throw new UsageError(`no profile '${name}' (turno profile list shows them; turno profile add ${name} creates it)`);
    return launchSafe(profileAgent(name, io.env), name, args, io);
  }
  const file = launcherPath(name, io.env);
  if (!file) {
    if (!isValidProfileName(name)) throw new UsageError(`unknown command '${name}' (turno --help)`);
    let declared = false;
    try {
      declared = listProfiles(loadConfig(io.env), io.env).includes(name);
    } catch {
      declared = false;
    }
    if (declared) {
      const agent = profileAgent(name, io.env);
      const missing = tildify(join(paths(io.env).bin, launcherName(name, agent)), io.env);
      throw new CliError(`profile ${name} has no launcher (${missing} is missing). Run: turno profile repair ${name}`);
    }
    throw new UsageError(`no profile '${name}' (turno profile list shows them; turno profile add ${name} creates it)`);
  }
  return execLauncher(file, args, io.env);
}

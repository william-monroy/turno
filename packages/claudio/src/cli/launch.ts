import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { constants } from "node:os";
import { delimiter, join } from "node:path";
import { isValidProfileName } from "../core/config.js";
import { paths } from "../core/paths.js";
import { type Io, UsageError } from "./io.js";

function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of a command found on PATH (or the command itself when it has a slash). */
export function findOnPath(cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (cmd.includes("/")) return executable(cmd) ? cmd : undefined;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, cmd);
    if (executable(file)) return file;
  }
  return undefined;
}

/** Path of a profile's launcher when it exists and is executable. */
export function launcherPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!isValidProfileName(name)) return undefined;
  const file = join(paths(env).bin, `claude-${name}`);
  return executable(file) ? file : undefined;
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

/** Exec a command looked up on PATH, as the shell's `exec cmd "$@"` would. */
export async function execCommand(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const file = findOnPath(cmd, env);
  if (!file) throw new UsageError(`${cmd}: command not found on PATH`);
  return execLauncher(file, args, env);
}

/** `claudio <profile> [args]`: exec the profile's launcher. */
export async function launchProfile(name: string, args: string[], io: Io): Promise<number> {
  const file = launcherPath(name, io.env);
  if (!file) {
    throw new UsageError(`no profile '${name}' (claudio status lists them; claudio setup ${name} creates it)`);
  }
  return execLauncher(file, args, io.env);
}

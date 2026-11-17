import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { Journal } from "../core/journal.js";
import { paths } from "../core/paths.js";
import { realOr } from "../core/fsutil.js";

const exec = promisify(execFile);

/**
 * How mcpd is kept alive across logins (ADR 0017): a LaunchAgent on macOS, a `systemd --user`
 * unit on Linux, nothing elsewhere. Every backend writes one file (journaled, so `turno undo`
 * restores it) and drives the service manager through its command-line tool.
 */

/** A failure the user can act on: printed as one line, never with a stack. */
export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceError";
  }
}

/** Set in the service environment, so `mcp daemon run` knows a supervisor restarts it. */
const SERVICE_ENV = "TURNO_MCPD_SERVICE";

export interface ServiceSpec {
  /** Program and its first arguments; `mcp daemon run` is appended. */
  program: string[];
  env: NodeJS.ProcessEnv;
}

export interface ServiceBackend {
  readonly kind: "launchd" | "systemd";
  /** "LaunchAgent" or "systemd user unit", for messages. */
  readonly noun: string;
  /** The file the backend writes. */
  file(env: NodeJS.ProcessEnv): string;
  render(spec: ServiceSpec): string;
  /** The program arguments recorded in an installed file. */
  programOf(text: string): string[];
  /** Load (or reload) the written file and start the service. */
  load(env: NodeJS.ProcessEnv): Promise<void>;
  /** Stop the service and keep it from starting at the next login. */
  unload(env: NodeJS.ProcessEnv): Promise<void>;
  restart(env: NodeJS.ProcessEnv): Promise<void>;
  isLoaded(env: NodeJS.ProcessEnv): Promise<boolean>;
}

/** The command line of the service: program, then `mcp daemon run`. */
export function serviceArgs(spec: ServiceSpec): string[] {
  return [...spec.program, "mcp", "daemon", "run"];
}

/** Variables the service needs: PATH (service managers start with a minimal one), HOME and turno's own overrides. */
export function serviceEnv(spec: ServiceSpec, kind: ServiceBackend["kind"]): Record<string, string> {
  const vars: Record<string, string> = {
    PATH: spec.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: paths(spec.env).home,
  };
  for (const k of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "LANG", "TURNO_CONFIG_DIR", "TURNO_STATE_DIR", "TURNO_DATA_DIR"]) {
    if (spec.env[k]) vars[k] = spec.env[k] as string;
  }
  vars[SERVICE_ENV] = kind;
  return vars;
}

/**
 * Run a service manager command. A missing tool becomes a one-line ServiceError instead of
 * `spawn launchctl ENOENT` with a stack.
 */
export async function runTool(tool: string, args: string[], env: NodeJS.ProcessEnv, timeout = 10_000): Promise<string> {
  try {
    const { stdout } = await exec(tool, args, { timeout, env });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") throw new ServiceError(`${tool} was not found on PATH; it is needed to manage the mcpd service`);
    const detail = (e.stderr ?? "").trim().split("\n")[0] || e.message.split("\n")[0];
    throw new ServiceError(`${tool} ${args.join(" ")} failed: ${detail}`);
  }
}

/**
 * Paths that change when a version manager or Homebrew switches versions. A service that
 * runs them breaks after `nvm uninstall`, `brew cleanup` and the like.
 */
const UNSTABLE = [/\/\.nvm\/versions\//, /\/Cellar\//, /\/\.volta\/tools\/image\//, /\/fnm\/node-versions\//, /\/\.asdf\/installs\//, /\/mise\/installs\//, /\/_npx\//, /\/\.npm\/_npx\//, /\/n\/versions\//, /\/\.local\/share\/pnpm\/\.tools\//, /\/\.local\/share\/pnpm\/dlx-/];

export function isUnstablePath(p: string): boolean {
  return UNSTABLE.some((re) => re.test(p));
}

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function whichAll(cmd: string, env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((d) => join(d, cmd))
    .filter(executable);
}

export interface ProgramChoice {
  program: string[];
  /** Why the choice may break later, when it may. */
  warning?: string;
}

/**
 * What the service should run. In order: a `turno` on PATH at a stable location that is this
 * same installation (or a Volta shim); the running node and script when both are stable; a
 * stable node found on PATH or in the usual places with this script when the script is
 * stable; otherwise the running node and script, with a warning.
 */
export function chooseProgram(opts: { env: NodeJS.ProcessEnv; execPath: string; script: string }): ProgramChoice {
  const script = realOr(opts.script);
  for (const t of whichAll("turno", opts.env)) {
    if (isUnstablePath(t)) continue;
    const r = realOr(t);
    if (r === script || basename(r) === "volta-shim") return { program: [t] };
  }
  if (!isUnstablePath(script)) {
    if (!isUnstablePath(opts.execPath)) return { program: [opts.execPath, script] };
    const node = [...whichAll("node", opts.env), "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].find((n) => !isUnstablePath(n) && executable(n));
    if (node) return { program: [node, script] };
  }
  return {
    program: [opts.execPath, script],
    warning: `the service runs ${opts.execPath} ${script}, a path that changes when your version manager or Homebrew switches versions; run \`turno upgrade --finish\` after that, or install turno where it has a stable path`,
  };
}

/** Whether `systemd --user` can be used here. */
async function systemdAvailable(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await exec("systemctl", ["--user", "show-environment"], { timeout: 5000, env });
    return true;
  } catch {
    return false;
  }
}

/**
 * The backend for this platform. Throws a one-line ServiceError where there is none (Linux
 * without systemd, other systems): `turno mcp daemon run` still works under any supervisor.
 */
export async function serviceBackend(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Promise<ServiceBackend> {
  if (platform === "darwin") return (await import("./launchd.js")).launchd;
  if (platform === "linux") {
    if (!(await systemdAvailable(env))) {
      throw new ServiceError("no systemd user instance here (systemctl --user does not answer); run `turno mcp daemon run` under your own supervisor instead");
    }
    return (await import("./systemd.js")).systemd;
  }
  throw new ServiceError(`keeping mcpd alive is not supported on ${platform}; run \`turno mcp daemon run\` under your own supervisor instead`);
}

/** The backend whose file is installed, without asking the service manager. */
export async function installedBackend(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Promise<ServiceBackend | undefined> {
  const b = platform === "darwin" ? (await import("./launchd.js")).launchd : platform === "linux" ? (await import("./systemd.js")).systemd : undefined;
  return b && existsSync(b.file(env)) ? b : undefined;
}

/** Write the service file through the journal and (unless dry) load it. */
export async function installService(backend: ServiceBackend, spec: ServiceSpec, journal: Journal): Promise<{ file: string; text: string; changed: boolean }> {
  const file = backend.file(spec.env);
  const text = backend.render(spec);
  let before: string | undefined;
  try {
    before = readFileSync(file, "utf8");
  } catch {
    before = undefined;
  }
  if (journal.dryRun) return { file, text, changed: before !== text };
  if (before !== text) journal.write(file, text, 0o644);
  await backend.load(spec.env);
  return { file, text, changed: before !== text };
}

/** Stop the service and remove its file through the journal (so it does not come back at login). */
export async function removeService(backend: ServiceBackend, env: NodeJS.ProcessEnv, journal: Journal): Promise<{ file: string; existed: boolean }> {
  const file = backend.file(env);
  const existed = existsSync(file);
  if (journal.dryRun) return { file, existed };
  if (await backend.isLoaded(env)) await backend.unload(env);
  if (existed) journal.remove(file);
  return { file, existed };
}

import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.js";

/**
 * A browser identity is a persistent Chrome user data dir (cookies, local storage, saved
 * logins) under `<data>/browser/identities/<id>`. One identity maps to one mcpd server
 * (`browser-<id>`), so a site login done once by hand is reused by every session.
 */

const IDENTITY_ID = /^[a-z0-9][a-z0-9_-]*$/;

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

export function isValidIdentityId(id: string): boolean {
  return IDENTITY_ID.test(id) && id.length <= 64;
}

export function assertIdentityId(id: string): void {
  if (!isValidIdentityId(id)) {
    throw new IdentityError(`invalid identity "${id}": use lowercase letters, digits, "-" and "_", starting with a letter or digit`);
  }
}

export function identityDir(id: string, env: NodeJS.ProcessEnv = process.env): string {
  assertIdentityId(id);
  return join(paths(env).identitiesDir, id);
}

export interface IdentityInfo {
  id: string;
  dir: string;
  /** A live Chrome holds the profile (its SingletonLock points to a running PID). */
  inUse: boolean;
}

export function identityExists(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = identityDir(id, env);
  return existsSync(dir) && statSync(dir).isDirectory();
}

export function listIdentities(env: NodeJS.ProcessEnv = process.env): IdentityInfo[] {
  const root = paths(env).identitiesDir;
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isValidIdentityId(d.name))
      .map((d) => d.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.sort().map((id) => ({ id, dir: join(root, id), inUse: isInUse(id, env) }));
}

/** Create the identity dir (mode 700). Returns its info; adding an existing identity is a no-op. */
export function addIdentity(id: string, env: NodeJS.ProcessEnv = process.env): IdentityInfo {
  const dir = identityDir(id, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { id, dir, inUse: isInUse(id, env) };
}

/** Delete the identity and everything in its profile. Refuses while Chrome holds it. */
export function removeIdentity(id: string, env: NodeJS.ProcessEnv = process.env): void {
  const dir = identityDir(id, env);
  if (!existsSync(dir)) throw new IdentityError(`identity "${id}" does not exist`);
  if (isInUse(id, env)) throw new IdentityError(`identity "${id}" is in use by a running Chrome; close it first`);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Chrome writes `SingletonLock` as a symlink whose target is `<hostname>-<pid>`.
 * Returns the PID, or undefined when the target does not have that shape.
 */
export function parseSingletonLock(target: string): number | undefined {
  const m = /-(\d+)$/.exec(target);
  if (!m) return undefined;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when the identity's Chrome profile is locked by a live process. */
export function isInUse(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let target: string;
  try {
    target = readlinkSync(join(identityDir(id, env), "SingletonLock"));
  } catch {
    return false;
  }
  const pid = parseSingletonLock(target);
  return pid !== undefined && pidAlive(pid);
}

import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { IdentityError, assertIdentityId, identityDir, identityStateDir, isValidIdentityId } from "./ids.js";
import { paths } from "./paths.js";
import { inUseMessage, readRuntimeLock, runtimeLockAlive } from "./runtime-lock.js";
import { type SettingsPatch, identitySettingsPath, systemTimezone, writeIdentitySettings } from "./settings.js";

export { IdentityError, assertIdentityId, identityDir, identityStateDir, isValidIdentityId };

/**
 * A browser identity is a persistent Chrome user data dir (cookies, local storage, saved
 * logins) under `<data>/browser/identities/<id>`. One identity maps to one mcpd server
 * (`browser-<id>`), so a site login done once by hand is reused by every session.
 */

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

/**
 * Create the identity dir (mode 700) and return its info. A new identity also gets its
 * identity.json, pinned to the system time zone plus the settings given, so it keeps the same
 * zone and languages from then on (ADR 0044). Adding an existing identity changes nothing,
 * unless settings are given: then they are written to its identity.json.
 */
export function addIdentity(id: string, env: NodeJS.ProcessEnv = process.env, settings: SettingsPatch = {}, now: Date = new Date()): IdentityInfo {
  const dir = identityDir(id, env);
  const created = !existsSync(dir);
  const given = Object.values(settings).some((v) => v !== undefined);
  if (created && !existsSync(identitySettingsPath(id, env))) {
    // Validate before creating anything, so a bad setting leaves no half-made identity.
    writeIdentitySettings(id, { timezone: systemTimezone(), ...settings }, env, now);
  } else if (given) {
    writeIdentitySettings(id, settings, env, now);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { id, dir, inUse: isInUse(id, env) };
}

/**
 * Delete the identity: its profile, its identity.json and what turno wrote for it (runtime
 * state, health, reputation log). Refuses while Chrome holds it.
 */
export function removeIdentity(id: string, env: NodeJS.ProcessEnv = process.env): void {
  const dir = identityDir(id, env);
  if (!existsSync(dir)) throw new IdentityError(`identity "${id}" does not exist`);
  const holder = inUseBy(id, env);
  if (holder) throw new IdentityError(`${holder} Remove it after that.`);
  if (isInUse(id, env)) throw new IdentityError(`identity "${id}" is in use by a running Chrome; close it first`);
  rmSync(dir, { recursive: true, force: true });
  rmSync(identitySettingsPath(id, env), { force: true });
  rmSync(identityStateDir(id, env), { recursive: true, force: true });
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

/** Who holds the identity right now (its runtime lock), as a message; undefined when nobody does. */
export function inUseBy(id: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const lock = readRuntimeLock(id, env);
  return lock && runtimeLockAlive(lock) ? inUseMessage(id, lock) : undefined;
}

/** True when a live process holds the identity's runtime lock or its Chrome profile. */
export function isInUse(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (inUseBy(id, env)) return true;
  let target: string;
  try {
    target = readlinkSync(join(identityDir(id, env), "SingletonLock"));
  } catch {
    return false;
  }
  const pid = parseSingletonLock(target);
  return pid !== undefined && pidAlive(pid);
}

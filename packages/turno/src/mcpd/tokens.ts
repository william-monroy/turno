import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite } from "../core/journal.js";
import { ensurePrivateDir, paths } from "../core/paths.js";
import { readState } from "../core/state-file.js";

/**
 * Per-profile gateway tokens. Each profile's agent config carries its own token,
 * derived from the master token so mcpd needs no list of them:
 *
 *   tp1.<profile>.<base64url(HMAC-SHA256(master, "profile:" + profile))>
 *
 * The profile name travels in clear (it is not a secret, the MAC is), so the gateway reads the
 * profile from the token itself and never from a header. Rotating the master token invalidates
 * every derived token at once.
 */
const PREFIX = "tp1";
const SHAPE = /^tp1\.([a-z0-9][a-z0-9_-]*)\.([A-Za-z0-9_-]{43})$/;

/** The token profile `profile` uses to reach mcpd. */
export function profileToken(master: string, profile: string): string {
  const mac = createHmac("sha256", master).update(`profile:${profile}`).digest("base64url");
  return `${PREFIX}.${profile}.${mac}`;
}

/** The profile a token was issued for under this master token, or undefined. */
export function tokenProfile(master: string, token: string): string | undefined {
  const m = SHAPE.exec(token);
  if (!m) return undefined;
  const want = Buffer.from(profileToken(master, m[1]!));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got) ? m[1] : undefined;
}

/**
 * Where a profile's token waits for launchers of agents that read it from the environment
 * (Codex, Copilot, Cursor, and agents set up by hand from `turno mcp config`).
 */
export function profileTokenFile(profile: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(paths(env).state, "mcpd-tokens", `${profile}.token`);
}

export function readProfileTokenFile(profile: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    return readFileSync(profileTokenFile(profile, env), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Write the profile's token file (mode 600) when it is missing or stale. True when it changed. */
export function writeProfileTokenFile(profile: string, master: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const token = profileToken(master, profile);
  if (readProfileTokenFile(profile, env) === token) return false;
  const file = profileTokenFile(profile, env);
  ensurePrivateDir(dirname(file), env);
  atomicWrite(file, `${token}\n`, 0o600);
  return true;
}

/**
 * Profiles whose token file `turno mcp sync` wrote, so a later sync removes only its own files
 * once their profile is gone; files written for agents set up by hand (`turno mcp config`, any
 * name) stay.
 */
function syncedListFile(env: NodeJS.ProcessEnv): string {
  return join(dirname(profileTokenFile("x", env)), "synced.json");
}

export function readSyncedTokenProfiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const v = readState(syncedListFile(env), (x: unknown): x is unknown[] => Array.isArray(x));
  return (v ?? []).filter((x): x is string => typeof x === "string");
}

export function writeSyncedTokenProfiles(names: string[], env: NodeJS.ProcessEnv = process.env): void {
  const file = syncedListFile(env);
  ensurePrivateDir(dirname(file), env);
  atomicWrite(file, `${JSON.stringify([...new Set(names)].sort())}\n`, 0o600);
}

/** Delete a profile's token file; true when there was one. */
export function removeProfileTokenFile(profile: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    rmSync(profileTokenFile(profile, env));
    return true;
  } catch {
    return false;
  }
}

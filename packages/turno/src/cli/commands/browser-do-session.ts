import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Owner } from "turno-core/cli";
import { writePrivateFile } from "turno-core/paths";
import { pidAlive } from "turno-core/process";
import type { Manifest, StdioServer } from "../../core/manifest.js";
import { paths } from "../../core/paths.js";

/**
 * The session of `turno browser do`. Each command is one call through mcpd, the way an agent's
 * tool call goes, so the identity's browser, its tab locks ("sharing": "tabs") or its one-session
 * lease ("sharing": "session"), humanize and recordings treat it like an agent session.
 *
 * What makes several commands one session is the mcpd session itself: the first command opens
 * one and saves its id in a private file, the next commands reconnect to it instead of opening
 * another, and mcpd keeps giving the browser the same `io.turno/session` id, so the commands keep
 * their tab. mcpd drops a session when the process named by its X-Turno-Pid header exits, so that
 * header names the process the commands belong to (`sessionOwner`): the coding agent that runs
 * them through a shell, or the terminal's shell. `turno browser do <id> end` ends it at once.
 */

// The owner of a session, its name and the lock moved to turno-core so turno-browser's own `do`
// shares them; re-exported here so turno's imports stay.
export { type Owner, ownerName, passesOn, sessionName, sessionOwner, withLock } from "turno-core/cli";

/** What a CLI session saves between commands. */
export interface SavedSession {
  v: 1;
  identity: string;
  server: string;
  profile: string;
  /** mcpd's port when the session opened: another port means another mcpd. */
  port: number;
  /** The Mcp-Session-Id mcpd gave; useless without the profile's token. */
  sessionId: string;
  protocolVersion?: string;
  owner: Owner;
  name: string;
  createdAt: string;
  usedAt: string;
}

/** Where CLI sessions are saved: <state>/browser-do. */
export function sessionsDir(env: NodeJS.ProcessEnv): string {
  return join(paths(env).state, "browser-do");
}

export function sessionFile(env: NodeJS.ProcessEnv, identity: string, owner: number, name: string): string {
  return join(sessionsDir(env), `${identity}.${owner}.${name}.json`);
}

export function readSaved(file: string): SavedSession | undefined {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Partial<SavedSession>;
    if (s.v !== 1 || typeof s.sessionId !== "string" || typeof s.port !== "number" || !s.owner) return undefined;
    return s as SavedSession;
  } catch {
    return undefined;
  }
}

export function writeSaved(file: string, saved: SavedSession, env: NodeJS.ProcessEnv): void {
  writePrivateFile(file, `${JSON.stringify(saved, null, 2)}\n`, env);
}

export function dropSaved(file: string): void {
  rmSync(file, { force: true });
}

/** Removes the saved sessions whose owner exited (mcpd dropped those sessions already). */
export function sweepSaved(env: NodeJS.ProcessEnv, alive: (pid: number) => boolean = pidAlive): void {
  let names: string[];
  try {
    names = readdirSync(sessionsDir(env));
  } catch {
    return;
  }
  for (const n of names) {
    const m = /^[^.]+\.(\d+)\.[^.]+\.json$/.exec(n);
    if (m && !alive(Number(m[1]))) dropSaved(join(sessionsDir(env), n));
  }
}

/**
 * The mcp.toml server that serves identity `id`: a stdio server with `--identity <id>` in its
 * args (`browser-<id>` first, as `turno browser add` prints it).
 */
export function identityServer(manifest: Manifest, id: string): StdioServer | undefined {
  const serves = (args: readonly string[]) =>
    args.some((a, i) => (a === "--identity" && args[i + 1] === id) || a === `--identity=${id}`);
  const found = Object.values(manifest.servers).filter((s): s is StdioServer => s.kind === "stdio" && serves(s.args));
  return found.find((s) => s.name === `browser-${id}`) ?? found.sort((a, b) => a.name.localeCompare(b.name))[0];
}

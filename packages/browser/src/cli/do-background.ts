import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CliError, type Owner, ownerName, sessionName, sessionOwner, str, withLock } from "turno-core/cli";
import { tildify, writePrivateFile } from "turno-core/paths";
import { pidAlive, readProcTable } from "turno-core/process";
import { backgroundDir } from "../background-state.js";
import { type BackgroundSession, backgroundStatus, openBackgroundSession } from "../client.js";
import { identityExists } from "../identities.js";
import type { DoSession, DoTarget, DoTransport, ToolResult } from "./do.js";

/**
 * How `turno-browser do` reaches an identity's browser without turno: through the identity's
 * background server (`turno-browser-mcp --identity <id> --background`), which the first command
 * starts and which exits after its idle time. Each command is one MCP session of that server,
 * the way an agent's tool call goes, so the identity's rules apply (tab locks or the one-session
 * lease, humanize, recordings, the vault).
 *
 * What makes several commands one session: the first command saves the server's session id in a
 * private file, the next ones continue it, and the server ends it when the process the commands
 * belong to exits (the coding agent or the terminal's shell, `sessionOwner`). Inside turno,
 * `turno browser do` goes through mcpd instead, with the same owner and session rules.
 */

/** What the transport calls; tests replace them. */
export interface BackgroundDoDeps {
  /** Who the commands belong to (`sessionOwner`). */
  owner(env: NodeJS.ProcessEnv): Owner;
  identityExists: typeof identityExists;
  backgroundStatus: typeof backgroundStatus;
  openBackgroundSession: typeof openBackgroundSession;
}

export const defaultBackgroundDoDeps: BackgroundDoDeps = {
  owner: (env) => sessionOwner(readProcTable(), process.ppid, Number(env.TURNO_SESSION_PID) || undefined),
  identityExists,
  backgroundStatus,
  openBackgroundSession,
};

const HELP = {
  intro: `Runs one action on the identity's browser through its background server, a turno-browser-mcp
that serves the identity to the shell (turno-browser background shows it). The first action starts
it; it exits after 15 minutes without a request (TURNO_BROWSER_BACKGROUND_IDLE changes that). While
it runs it alone drives the identity's browser: an agent's turno-browser-mcp for the same identity
answers with an error that names it. With turno installed, turno browser do goes through mcpd
instead.`,
  session: `Session: the commands one agent or one terminal shell runs are one session, so they keep their
tab and their place in the tab locks ("sharing": "tabs") or hold the identity's one-session lease
("sharing": "session"). The session belongs to the process that runs the commands: the coding
agent (each of its shell commands passes through a short-lived shell) or your terminal's shell.
It ends when that process exits, with 'end' or 'close', or when the background server exits.
--session <name> (or TURNO_BROWSER_SESSION) keeps several sessions apart under one owner, for
example two subagents each in its own tab.`,
  output: `Output: url: and title: lines, then what the action returned; errors go to stderr with exit 1.
--snapshot after an action prints the snapshot too; --json prints one object.
--timeout <seconds> (default 120) bounds one action; attach mode can wait for Chrome's consent
dialog.`,
};

/** What a session saves between commands. */
interface SavedSession {
  v: 1;
  identity: string;
  /** The background server the session lives in: another pid means the session is gone. */
  serverPid: number;
  /** The Mcp-Session-Id it gave; reachable only through the user's private socket or token. */
  sessionId: string;
  protocolVersion?: string;
  owner: Owner;
  name: string;
  createdAt: string;
  usedAt: string;
}

/** Where the sessions of `do` are saved: the background server's private folder. */
function sessionsDir(id: string, env: NodeJS.ProcessEnv): string {
  return join(backgroundDir(id, env), "do");
}

function readSaved(file: string): SavedSession | undefined {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Partial<SavedSession>;
    if (s.v !== 1 || typeof s.sessionId !== "string" || typeof s.serverPid !== "number" || !s.owner) return undefined;
    return s as SavedSession;
  } catch {
    return undefined;
  }
}

function dropSaved(file: string): void {
  rmSync(file, { force: true });
}

/** Removes the saved sessions whose owner exited (the server ended those sessions already). */
function sweepSaved(dir: string): void {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  for (const f of files) {
    const m = /^(\d+)\.[^.]+\.json$/.exec(f);
    if (m && !pidAlive(Number(m[1]))) dropSaved(join(dir, f));
  }
}

/** An idle limit in words: 15m, 1h, 90s. */
export function formatIdle(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

function message(err: unknown): string {
  return ((err as Error)?.message ?? String(err)).replace(/^(Error: )?/, "");
}

/** The background transport of `turno-browser do`. */
export function backgroundTransport(deps: BackgroundDoDeps = defaultBackgroundDoDeps): DoTransport {
  return {
    help: HELP,
    flags: {},
    async target(id, p, io): Promise<DoTarget> {
      const api = deps;
      const env = io.env;
      if (!api.identityExists(id, env))
        throw new CliError(`browser identity "${id}" does not exist (turno-browser add ${id})`);
      const owner = deps.owner(env);
      const name = sessionName(str(p, "session"), env);
      const dir = sessionsDir(id, env);
      const file = join(dir, `${owner.pid}.${name}.json`);
      sweepSaved(dir);
      /** The saved session when its server still runs, and that server's pid. */
      const current = (): SavedSession | undefined => {
        const saved = readSaved(file);
        const server = api.backgroundStatus(id, { env });
        return saved && server && saved.serverPid === server.pid && saved.owner.pid === owner.pid ? saved : undefined;
      };
      /** Open the saved session again (or a new one), without starting a server. */
      const reopen = async (saved: SavedSession): Promise<BackgroundSession | undefined> =>
        await api
          .openBackgroundSession(id, {
            env,
            owner: owner.pid,
            start: false,
            session: {
              id: saved.sessionId,
              ...(saved.protocolVersion ? { protocolVersion: saved.protocolVersion } : {}),
            },
          })
          .catch(() => undefined);
      return {
        head: { identity: id, server: "background", profile: null },
        info: (resumed) => ({ name, ownerPid: owner.pid, owner: ownerName(owner), resumed }),
        describe() {
          const saved = current();
          const server = api.backgroundStatus(id, { env });
          return {
            open: saved !== undefined,
            lines: [
              `identity: ${id}`,
              server
                ? `server: background server (pid ${server.pid}) since ${server.startedAt}`
                : "server: not running; the next action starts it",
              `session: ${name}, owned by ${ownerName(owner)} (pid ${owner.pid})`,
              saved
                ? `state: open since ${saved.createdAt}, last used ${saved.usedAt}`
                : "state: none yet; the next action opens it",
              `ends: when pid ${owner.pid} exits, with 'end' or 'close', or when the background server exits`,
              `file: ${tildify(file, env)}`,
            ],
          };
        },
        async end() {
          const saved = readSaved(file);
          if (!saved) return false;
          const live = current();
          if (live) await (await reopen(live))?.end();
          dropSaved(file);
          return true;
        },
        afterEnd() {
          const server = api.backgroundStatus(id, { env });
          if (!server) return undefined;
          const idle =
            server.idleMs > 0 ? `until it has been idle for ${formatIdle(server.idleMs)}` : "until you stop it";
          return `Chrome stays open in the background server ${idle}; turno-browser background stop ${id} closes it now.`;
        },
        session: (fn) =>
          withLock(file, env, async () => {
            let saved: SavedSession | undefined = current();
            if (!saved) dropSaved(file); // another server, or none: that session is gone
            let s: BackgroundSession;
            try {
              s = await api.openBackgroundSession(id, {
                env,
                owner: owner.pid,
                clientName: "turno-browser-do",
                ...(saved
                  ? {
                      session: {
                        id: saved.sessionId,
                        ...(saved.protocolVersion ? { protocolVersion: saved.protocolVersion } : {}),
                      },
                    }
                  : {}),
              });
            } catch (err) {
              throw new CliError(message(err));
            }
            if (!s.resumed) saved = undefined;
            let used = false;
            let ended = false;
            const session: DoSession = {
              resumed: s.resumed,
              async call(tool, args, timeoutMs): Promise<ToolResult> {
                let result: ToolResult;
                try {
                  result = await s.callTool(tool, args, { timeoutMs });
                } catch (err) {
                  // A session this command opened and could not use goes at once.
                  if (!s.resumed && !used) await s.end();
                  throw new CliError(`${tool}: ${message(err)}`);
                }
                if (!used && !ended) {
                  const now = new Date().toISOString();
                  const next: SavedSession = {
                    v: 1,
                    identity: id,
                    serverPid: s.state.pid,
                    sessionId: s.id,
                    ...(s.protocolVersion ? { protocolVersion: s.protocolVersion } : {}),
                    owner,
                    name,
                    createdAt: saved?.createdAt ?? now,
                    usedAt: now,
                  };
                  writePrivateFile(file, `${JSON.stringify(next, null, 2)}\n`, env);
                }
                used = true;
                return result;
              },
              async end() {
                ended = true;
                await s.end();
                dropSaved(file);
              },
            };
            try {
              return await fn(session);
            } finally {
              // Never end the session here: the next command of this owner continues it.
              if (!ended) await s.close();
            }
          }),
      };
    },
  };
}

import { readProcTable } from "turno-core/process";
import type { DoSession, DoTarget, DoTransport, ToolResult } from "turno-browser";
import { gatewayUrl } from "../../agents/adapter.js";
import { loadManifest, servesProfile } from "../../core/manifest.js";
import { tildify } from "../../core/paths.js";
import { packageInfo } from "../../core/version.js";
import { type Parsed, str } from "../args.js";
import { Exit } from "../exit.js";
import { CliError, type Io } from "../io.js";
import {
  type Owner,
  type SavedSession,
  dropSaved,
  identityServer,
  ownerName,
  readSaved,
  sessionFile,
  sessionName,
  sessionOwner,
  sweepSaved,
  withLock,
  writeSaved,
} from "./browser-do-session.js";
import { callerProfile, gatewayMessage } from "./mcp-call.js";

/**
 * How `turno browser do` reaches an identity's browser: through mcpd, as one gateway session of
 * a profile, the way an agent's tool call goes. turno-browser runs the command itself (the
 * actions, the output); this is the transport it calls. The session that keeps the commands of
 * one agent or shell on one tab is in `browser-do-session.ts`.
 */

export interface DoDeps {
  /** The process the CLI session belongs to (`sessionOwner`). */
  owner(env: NodeJS.ProcessEnv): Owner;
  /** All of stdin, for `type <ref> -`; turno-browser reads it itself when not given. */
  stdin?: () => Promise<string>;
}

export const defaultDoDeps: DoDeps = {
  owner: (env) => sessionOwner(readProcTable(), process.ppid, Number(env.TURNO_SESSION_PID) || undefined),
};

const HELP = {
  intro: `Runs one action on the identity's browser through mcpd and turno-browser-mcp, the server
agents use, so the identity's rules apply as they do to an agent's tool call. The identity must
be served by mcpd (its [server.browser-<id>] block in mcp.toml, which turno browser add prints).`,
  session: `Session: the commands one agent or one terminal shell runs are one session, so they keep their
tab and their place in the tab locks ("sharing": "tabs") or hold the identity's one-session lease
("sharing": "session"). The session belongs to the process that runs the commands: the coding
agent (each of its shell commands passes through a short-lived shell) or your terminal's shell.
It ends when that process exits, with 'end' or 'close', or when mcpd restarts. --session <name>
(or TURNO_BROWSER_SESSION) keeps several sessions apart under one owner, for example two
subagents each in its own tab.`,
  output: `Output: url: and title: lines, then what the action returned; errors go to stderr with exit 1.
--snapshot after an action prints the snapshot too; --json prints one object.
--timeout <seconds> (default 120) bounds one action; attach mode can wait for Chrome's consent
dialog. --profile picks the profile whose token and tool filter apply (default: this folder's).`,
};

interface Target {
  identity: string;
  server: string;
  profile: string;
  port: number;
  token: string;
  owner: Owner;
  name: string;
  file: string;
  /** The token of another profile, to end a session that profile opened. */
  tokenFor(profile: string): string;
}

type Client = import("@modelcontextprotocol/sdk/client/index.js").Client;
type Transport = import("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport;

const down = () => new CliError("mcpd is not running (turno mcp daemon start)", Exit.gatewayDown);

async function open(t: Target, saved?: SavedSession): Promise<{ client: Client; transport: Transport }> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const transport = new StreamableHTTPClientTransport(new URL(gatewayUrl(t.server, t.port)), {
    ...(saved ? { sessionId: saved.sessionId } : {}),
    requestInit: {
      headers: {
        Authorization: `Bearer ${t.token}`,
        "X-Turno-Profile": t.profile,
        // The session's owner, not this short-lived process: mcpd keeps the session while it lives.
        "X-Turno-Pid": String(t.owner.pid),
        "X-Turno-Cwd-B64": Buffer.from(process.cwd(), "utf8").toString("base64url"),
      },
    },
  });
  if (saved?.protocolVersion) transport.setProtocolVersion(saved.protocolVersion);
  const client = new Client({ name: "turno-browser-do", version: packageInfo().version }, { capabilities: {} });
  try {
    await client.connect(transport);
  } catch (err) {
    const g = gatewayMessage(err);
    if (g.status === undefined && /ECONNREFUSED|fetch failed|connect/i.test(g.message)) throw down();
    throw new CliError(`mcpd refused the session for ${t.server} as profile ${t.profile}: ${g.message}`);
  }
  if (!saved && client.getServerVersion()?.version === "hidden")
    throw new CliError(client.getInstructions() ?? `${t.server} is hidden in this folder`);
  return { client, transport };
}

function freshSaved(t: Target, transport: Transport, previous?: SavedSession): SavedSession {
  const now = new Date().toISOString();
  return {
    v: 1,
    identity: t.identity,
    server: t.server,
    profile: t.profile,
    port: t.port,
    sessionId: transport.sessionId!,
    ...(transport.protocolVersion ? { protocolVersion: transport.protocolVersion } : {}),
    owner: t.owner,
    name: t.name,
    createdAt: previous?.createdAt ?? now,
    usedAt: now,
  };
}

/** A saved session this command can continue: same mcpd, server, profile and owner. */
function usable(saved: SavedSession | undefined, t: Target): boolean {
  return (
    saved !== undefined &&
    saved.port === t.port &&
    saved.server === t.server &&
    saved.profile === t.profile &&
    saved.owner.pid === t.owner.pid
  );
}

/** mcpd no longer knows the session (it answers 404): the command opens a new one. */
function sessionGone(err: unknown): boolean {
  const g = gatewayMessage(err);
  return g.status === 404 || /session not found|unknown session/i.test(g.message);
}

async function terminate(t: Target, saved: SavedSession): Promise<void> {
  const { transport, client } = await open(t, saved).catch(() => ({ transport: undefined, client: undefined }));
  await transport?.terminateSession().catch(() => {});
  await client?.close().catch(() => {});
}

/**
 * Ends a saved session when the mcpd that holds it still runs (it may hold the identity's
 * lease), with the token of the profile that opened it. Another mcpd forgot it already.
 */
async function endSaved(t: Target, saved: SavedSession): Promise<void> {
  if (saved.port !== t.port || saved.owner.pid !== t.owner.pid) return;
  await terminate({ ...t, server: saved.server, profile: saved.profile, token: t.tokenFor(saved.profile) }, saved);
}

async function resolveTarget(id: string, p: Parsed, io: Io, deps: DoDeps): Promise<Target> {
  const manifest = loadManifest(io.env);
  const def = identityServer(manifest, id);
  if (!def)
    throw new CliError(
      `browser identity "${id}" is not served by mcpd: add its block to mcp.toml (turno browser add ${id} prints it, or use [server.browser-${id}] with args = ["--identity", "${id}"]) and run turno mcp sync`,
    );
  const profile = callerProfile(str(p, "profile"), io.env, process.cwd());
  if (!servesProfile(def, profile))
    throw new CliError(
      `${def.name} is not served to profile ${profile} (profiles = ${JSON.stringify(def.profiles)} in mcp.toml); pick another with --profile`,
    );
  const { mcpdPort, readToken } = await import("../../mcpd/state.js");
  const { profileToken } = await import("../../mcpd/tokens.js");
  const master = readToken(io.env);
  if (!master) throw down();
  const owner = deps.owner(io.env);
  const name = sessionName(str(p, "session"), io.env);
  return {
    identity: id,
    server: def.name,
    profile,
    port: mcpdPort(io.env),
    token: profileToken(master, profile),
    owner,
    name,
    file: sessionFile(io.env, id, owner.pid, name),
    tokenFor: (other) => profileToken(master, other),
  };
}

/** Run `fn` in the saved session of `t`, or a new one, under the session file's lock. */
async function inSession<T>(t: Target, io: Io, fn: (s: DoSession) => Promise<T>): Promise<T> {
  return await withLock(t.file, io.env, async () => {
    let saved = readSaved(t.file);
    if (saved && !usable(saved, t)) {
      // Another mcpd, server, profile or owner: that session is not this one's to continue.
      await endSaved(t, saved);
      dropSaved(t.file);
      saved = undefined;
    }
    let resumed = saved !== undefined;
    let used = false;
    let ended = false;
    let conn = await open(t, saved);
    const raw = async (name: string, a: Record<string, unknown>, timeout: number): Promise<ToolResult> =>
      (await conn.client.callTool({ name, arguments: a }, undefined, {
        timeout,
        resetTimeoutOnProgress: true,
      })) as ToolResult;
    // A session this command opened and could not use (a lease another session holds, a
    // refused call) goes at once instead of waiting for its owner to exit.
    const giveUp = async (tool: string, err: unknown): Promise<never> => {
      if (!resumed && !used) await conn.transport.terminateSession().catch(() => {});
      throw new CliError(`${tool}: ${gatewayMessage(err).message}`);
    };
    const session: DoSession = {
      get resumed() {
        return resumed;
      },
      async call(tool, args, timeout): Promise<ToolResult> {
        let result: ToolResult;
        try {
          result = await raw(tool, args, timeout);
        } catch (err) {
          if (!resumed || used || !sessionGone(err)) return await giveUp(tool, err);
          // mcpd forgot the session (it restarted and could not rebuild it): start a new one.
          await conn.client.close().catch(() => {});
          dropSaved(t.file);
          resumed = false;
          conn = await open(t);
          try {
            result = await raw(tool, args, timeout);
          } catch (again) {
            return await giveUp(tool, again);
          }
        }
        if (!used && !ended) writeSaved(t.file, freshSaved(t, conn.transport, saved), io.env);
        used = true;
        return result;
      },
      async end() {
        ended = true;
        await conn.transport.terminateSession().catch(() => {});
        dropSaved(t.file);
      },
    };
    try {
      return await fn(session);
    } finally {
      // Never terminateSession here: the next command of this session reconnects to it.
      await conn.client.close().catch(() => {});
    }
  });
}

/** The mcpd transport of `turno browser do`. */
export function mcpdTransport(deps: DoDeps = defaultDoDeps): DoTransport {
  return {
    help: HELP,
    flags: { profile: { type: "string" } },
    async target(id, p, io): Promise<DoTarget> {
      const t = await resolveTarget(id, p, io, deps);
      sweepSaved(io.env);
      const identity = `browser:${id}`;
      return {
        head: { identity, server: t.server, profile: t.profile },
        info: (resumed) => ({ name: t.name, ownerPid: t.owner.pid, owner: ownerName(t.owner), resumed }),
        describe() {
          const found = readSaved(t.file);
          const saved = usable(found, t) ? found : undefined;
          return {
            open: saved !== undefined,
            lines: [
              `identity: ${identity} (server ${t.server}, profile ${t.profile})`,
              `session: ${t.name}, owned by ${ownerName(t.owner)} (pid ${t.owner.pid})`,
              saved
                ? `state: open since ${saved.createdAt}, last used ${saved.usedAt}`
                : "state: none yet; the next action opens it",
              `ends: when pid ${t.owner.pid} exits, with 'end' or 'close', or when mcpd restarts`,
              `file: ${tildify(t.file, io.env)}`,
            ],
          };
        },
        async end() {
          const saved = readSaved(t.file);
          if (saved) await endSaved(t, saved);
          dropSaved(t.file);
          return saved !== undefined;
        },
        session: (fn) => inSession(t, io, fn),
      };
    },
  };
}

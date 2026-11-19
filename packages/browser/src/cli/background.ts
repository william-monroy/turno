import {
  type Command,
  type FlagSpec,
  type Io,
  JSON_FLAG,
  type Sub,
  bool,
  emit,
  fail,
  group,
  jsonOutput,
  parseFlags,
  str,
} from "turno-core/cli";
import type { BackgroundState } from "../background-state.js";
import type { Ctx } from "./context.js";

/**
 * `turno-browser background`: the background server of each identity, the turno-browser-mcp
 * that `turno-browser do` starts to reach the identity's browser from the shell. `status` shows
 * which run, `start` starts one ahead, `stop` stops one (it closes its Chrome first).
 */

/** `background status --json`: one element per running server. */
export const BACKGROUND_JSON = jsonOutput(["identity", "pid", "startedAt", "idleMs", "transport", "version"]);

function duration(ms: number): string {
  if (ms <= 0) return "never";
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

function row(s: BackgroundState) {
  return {
    identity: s.identity,
    pid: s.pid,
    startedAt: s.startedAt,
    idleMs: s.idleMs,
    transport: s.transport ?? null,
    version: s.version,
  };
}

function checkId(c: Ctx, id: string | undefined, sub: string): string {
  if (!id)
    return fail(`background ${sub} needs an identity id (for example: ${c.names.browser} background ${sub} school)`);
  try {
    c.api.assertIdentityId(id);
  } catch (err) {
    return fail((err as Error).message);
  }
  return id;
}

function status(c: Ctx, args: string[], io: Io): number {
  const p = parseFlags(args, JSON_FLAG, 1);
  const given = p.positionals[0];
  const ids = given ? [checkId(c, given, "status")] : c.api.listIdentities(io.env).map((i) => i.id);
  const running = ids.flatMap((id) => {
    const s = c.api.backgroundStatus(id, { env: io.env });
    return s ? [s] : [];
  });
  if (bool(p, "json")) {
    emit(io, p, BACKGROUND_JSON, running.map(row));
    return 0;
  }
  if (!running.length) {
    io.out(
      given
        ? `No background server of "${given}" runs. ${c.names.browser} do ${given} <action> starts one.`
        : `No background server runs. ${c.names.browser} do <id> <action> starts one.`,
    );
    return 0;
  }
  const width = Math.max(...running.map((s) => s.identity.length));
  for (const s of running)
    io.out(
      `${s.identity.padEnd(width)}  pid ${s.pid}  since ${s.startedAt}  idle exit ${duration(s.idleMs)}  ${s.transport ?? "starting"}`,
    );
  return 0;
}

const START_FLAGS: FlagSpec = { idle: { type: "string" }, headless: { type: "boolean" } };

async function start(c: Ctx, args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, START_FLAGS, 1);
  const id = checkId(c, p.positionals[0], "start");
  if (!c.api.identityExists(id, io.env)) return fail(`identity "${id}" does not exist (${c.names.browser} add ${id})`);
  const idle = str(p, "idle");
  const extra = [
    ...(idle !== undefined ? ["--background-idle", idle] : []),
    ...(bool(p, "headless") ? ["--headless"] : []),
  ];
  let started: Awaited<ReturnType<Ctx["api"]["startBackground"]>>;
  try {
    started = await c.api.startBackground(id, { env: io.env, args: extra });
  } catch (err) {
    return fail((err as Error).message);
  }
  const { state } = started;
  io.out(
    started.started
      ? `started the background server of "${id}" (pid ${state.pid}); it exits after ${duration(state.idleMs)} without a request`
      : `the background server of "${id}" already runs (pid ${state.pid}, since ${state.startedAt})`,
  );
  return 0;
}

async function stop(c: Ctx, args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, {}, 1);
  const id = checkId(c, p.positionals[0], "stop");
  const pid = c.api.backgroundStatus(id, { env: io.env })?.pid;
  if (!(await c.api.stopBackground(id, { env: io.env }))) {
    io.out(`no background server of "${id}" runs`);
    return 0;
  }
  io.out(`stopped the background server of "${id}"${pid ? ` (pid ${pid})` : ""} and its Chrome`);
  return 0;
}

const BACKGROUND_FOOTER = `The background server of an identity is the turno-browser-mcp that \`do\` starts to reach the
identity's browser from the shell, on a socket in a folder only you can enter. While it runs it
alone drives the identity's browser: an agent's server for the same identity answers with an
error that names it. It exits after 15 minutes without a request (start --idle, or
TURNO_BROWSER_BACKGROUND_IDLE), and stop closes its Chrome first.`;

/** The `background` group. */
export function backgroundCommand(c: Ctx): Command {
  const b = c.names.browser;
  const subs: Record<string, Sub> = {
    status: {
      summary: "which identities have a background server running",
      synopsis: "[<id>] [--json]",
      flags: ["--json"],
      json: BACKGROUND_JSON,
      run: async (args, io) => status(c, args, io),
    },
    start: {
      summary: "start an identity's background server ahead of the first do",
      synopsis: "<id> [--idle <duration>] [--headless]",
      flags: ["--idle", "--headless"],
      run: (args, io) => start(c, args, io),
    },
    stop: {
      summary: "stop an identity's background server and its Chrome",
      synopsis: "<id>",
      run: (args, io) => stop(c, args, io),
    },
  };
  return group(`${c.names.subject}background`, "the background server do uses", subs, {
    fallback: "status",
    footer: BACKGROUND_FOOTER,
    prefix: `${b} background`,
    examples: [`${b} background status`, `${b} background start school --idle 30m`, `${b} background stop school`],
  });
}

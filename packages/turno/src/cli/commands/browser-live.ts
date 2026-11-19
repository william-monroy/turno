import { spawn } from "node:child_process";
import { type FlagSpec, JSON_FLAG, bool, parseFlags } from "../args.js";
import { Exit } from "../exit.js";
import { type Io, fail } from "../io.js";
import { emit, jsonOutput } from "../output.js";
import { style } from "../style.js";
import type { BrowserApi } from "./browser.js";

/**
 * `turno browser live|pause|resume <id>`: the live view and take-over of the turno-browser-mcp
 * that serves an identity (turno-browser's `live-server.ts`). The view opens in the default
 * browser through a link that works once; the link is never printed.
 */

type LiveStatus = NonNullable<Awaited<ReturnType<BrowserApi["liveStatus"]>>>;

/** `turno browser live|pause|resume <id> --json`. */
export const LIVE_JSON = jsonOutput([
  "identity",
  "pid",
  "port",
  "started",
  "paused",
  "waiting",
  "busy",
  "wait",
  "browser",
  "engine",
  "view",
  "showing",
  "pinned",
  "hidden",
  "viewers",
  "tabs",
]);

/** Opens a link in the default browser; injectable for tests. */
export type OpenUrl = (url: string, io: Io) => Promise<void>;

const openInBrowser: OpenUrl = async (url, io) => {
  const { openInvocation } = await import("./open.js");
  const inv = openInvocation(undefined, url, io.env);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(inv.command, inv.args, { stdio: "ignore", env: io.env, detached: true });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
};

function needIdentity(mod: BrowserApi, id: string | undefined, sub: string, io: Io): string {
  if (!id) return fail(`browser ${sub} needs an identity id (for example: turno browser ${sub} school)`);
  mod.assertIdentityId(id);
  if (!mod.identityExists(id, io.env))
    return fail(`identity "${id}" does not exist (turno identity add browser:${id})`);
  return id;
}

/** `120000` as "2m", `90000` as "90s". */
function seconds(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`;
}

/** Why there is no live view to talk to: off, or no server running now. */
function notServing(mod: BrowserApi, id: string, io: Io): number {
  const on = mod.checkIdentitySettings(id, io.env).settings?.live?.enabled === true;
  return fail(
    on
      ? `no turno-browser-mcp serves "${id}" right now. The live view starts with the server (an agent session that uses browser-${id} starts it).`
      : `the live view is off for "${id}" (the default). Turn it on with turno browser set ${id} --live true; it starts with the next turno-browser-mcp for this identity.`,
  );
}

function describe(status: LiveStatus, io: Io): void {
  const s = style(io);
  const state = status.paused
    ? `paused for ${seconds(Math.max(0, Date.now() - Date.parse(status.paused.since)))} (${status.paused.by})${status.waiting ? `, ${status.waiting} call${status.waiting === 1 ? "" : "s"} waiting` : ""}`
    : status.busy
      ? "the agent is working"
      : "the agent is idle";
  io.out(`${s.bold(status.identity)}  ${state}`);
  io.out(
    s.muted(
      `  browser ${status.browser ? `running (${status.engine})` : "not running"}; a paused call waits up to ${seconds(status.wait)}`,
    ),
  );
  if (!status.view.available && status.view.reason) io.out(s.note("info", status.view.reason, 2));
  for (const t of status.tabs)
    io.out(
      `  ${t.id === status.showing ? "*" : " "} ${t.title || "(no title)"}  ${s.muted(t.url)}${t.session ? s.muted(` [${t.session}]`) : ""}`,
    );
}

const LIVE_FLAGS: FlagSpec = { "no-open": { type: "boolean" }, ...JSON_FLAG };

export async function live(mod: BrowserApi, args: string[], io: Io, open: OpenUrl = openInBrowser): Promise<number> {
  const p = parseFlags(args, LIVE_FLAGS, 1);
  const id = needIdentity(mod, p.positionals[0], "live", io);
  const status = await mod.liveStatus(id, io.env);
  if (!status) return notServing(mod, id, io);
  if (bool(p, "json")) {
    emit(io, p, LIVE_JSON, status);
    return Exit.ok;
  }
  describe(status, io);
  if (!status.view.available || bool(p, "no-open")) return Exit.ok;
  await open(await mod.liveLink(id, io.env), io);
  io.err(
    style(io).muted(
      `opened the live view of "${id}" in your browser (the link works once; run this again for a new one)`,
    ),
  );
  return Exit.ok;
}

export async function pause(mod: BrowserApi, args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, JSON_FLAG, 1);
  const id = needIdentity(mod, p.positionals[0], "pause", io);
  if (!(await mod.liveStatus(id, io.env))) return notServing(mod, id, io);
  const status = await mod.livePause(id, io.env);
  if (bool(p, "json")) {
    emit(io, p, LIVE_JSON, status);
    return Exit.ok;
  }
  io.out(
    `paused "${id}": the agent's next call waits up to ${seconds(status.wait)} for you. Act in the browser${status.view.available ? ` or the live view (turno browser live ${id})` : ""}, then: turno browser resume ${id}`,
  );
  return Exit.ok;
}

export async function resume(mod: BrowserApi, args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, JSON_FLAG, 1);
  const id = needIdentity(mod, p.positionals[0], "resume", io);
  const before = await mod.liveStatus(id, io.env);
  if (!before) return notServing(mod, id, io);
  const status = await mod.liveResume(id, io.env);
  if (bool(p, "json")) {
    emit(io, p, LIVE_JSON, status);
    return Exit.ok;
  }
  io.out(
    before?.paused
      ? `resumed "${id}": the agent's waiting calls go on, and each is told what changed.`
      : `"${id}" was not paused.`,
  );
  return Exit.ok;
}

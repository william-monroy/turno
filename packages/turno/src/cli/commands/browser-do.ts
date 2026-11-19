import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readProcTable } from "turno-core/process";
import { gatewayUrl } from "../../agents/adapter.js";
import { loadManifest, servesProfile } from "../../core/manifest.js";
import { packageInfo } from "../../core/version.js";
import { type FlagSpec, JSON_FLAG, type Parsed, bool, parseFlags, str } from "../args.js";
import { Exit } from "../exit.js";
import { CliError, type Io, columns, examplesBlock, fail } from "../io.js";
import { emit, jsonArg, jsonOutput } from "../output.js";
import { tildify } from "../../core/paths.js";
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
import { type ContentItem, callArguments, callerProfile, gatewayMessage } from "./mcp-call.js";

/**
 * `turno browser do <id> <action>`: one browser action on an identity's browser from the shell,
 * for coding agents that prefer commands over MCP tools. Each action is one stock (or turno)
 * tool call through mcpd to the identity's turno-browser-mcp, the server agents use, so every
 * rule of the identity applies as it does to an agent: the tab locks or the one-session lease,
 * attach mode, read mode's refusals, humanize, recordings, the vault. The session that keeps the
 * commands of one agent or shell on one tab is in `browser-do-session.ts`.
 *
 * The output is short and stable: `url:` and `title:` lines, then what the action returned. The
 * code upstream ran and the snapshot file an action saves on the server are left out; a snapshot
 * comes from `snapshot` (or `--snapshot` after an action).
 */

/** `turno browser do --json`: one object per command. */
export const DO_JSON = jsonOutput([
  "identity",
  "server",
  "profile",
  "session",
  "action",
  "tool",
  "ok",
  "page",
  "result",
  "snapshot",
  "file",
  "notes",
  "error",
]);

export interface DoDeps {
  /** The process the CLI session belongs to (`sessionOwner`). */
  owner(env: NodeJS.ProcessEnv): Owner;
  /** All of stdin, for `type <ref> -`. */
  stdin(): Promise<string>;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export const defaultDoDeps: DoDeps = {
  owner: (env) => sessionOwner(readProcTable(), process.ppid, Number(env.TURNO_SESSION_PID) || undefined),
  stdin: readStdin,
};

/** How an action's result is printed. */
type Shape = "page" | "snapshot" | "read" | "screenshot" | "result" | "raw";

interface Call {
  tool: string;
  args: Record<string, unknown>;
}

interface Action {
  synopsis: string;
  summary: string;
  flags?: FlagSpec;
  /** Fewest and most positionals after the action name. */
  min: number;
  max: number;
  shape: Shape;
  build(pos: string[], p: Parsed, deps: DoDeps): Call | Promise<Call>;
}

/** `read`: the visible text of the page, or of one element. Works in read mode too (no layout: textContent). */
const READ_FUNCTION =
  "(element) => { const node = element || document.body || document.documentElement; if (!node) return ''; const text = typeof node.innerText === 'string' ? node.innerText : node.textContent; return String(text || '').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim(); }";

const DEFAULT_MAX_CHARS = 20_000;

function int(p: Parsed, name: string): number | undefined {
  const v = str(p, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) fail(`--${name} must be a whole number, not "${v}"`);
  return n;
}

const ACTIONS: Record<string, Action> = {
  open: {
    synopsis: "<url>",
    summary: "go to a URL in the session's tab",
    min: 1,
    max: 1,
    shape: "page",
    build: ([url]) => ({ tool: "browser_navigate", args: { url } }),
  },
  back: {
    synopsis: "",
    summary: "go back in the tab's history",
    min: 0,
    max: 0,
    shape: "page",
    build: () => ({ tool: "browser_navigate_back", args: {} }),
  },
  snapshot: {
    synopsis: "[<ref>] [--depth <n>]",
    summary: "the page's accessibility tree with refs (e12) to act on; <ref> limits it to one element",
    flags: { depth: { type: "string" } },
    min: 0,
    max: 1,
    shape: "snapshot",
    build: ([ref], p) => {
      const depth = int(p, "depth");
      return {
        tool: "browser_snapshot",
        args: { ...(ref ? { target: ref } : {}), ...(depth !== undefined ? { depth } : {}) },
      };
    },
  },
  read: {
    synopsis: "[<ref>] [--max-chars <n>]",
    summary: `the visible text of the page or one element (first ${DEFAULT_MAX_CHARS} characters; --max-chars 0 for all)`,
    flags: { "max-chars": { type: "string" } },
    min: 0,
    max: 1,
    shape: "read",
    build: ([ref]) => ({
      tool: "browser_evaluate",
      args: { function: READ_FUNCTION, ...(ref ? { target: ref } : {}) },
    }),
  },
  find: {
    synopsis: "<text>",
    summary: "elements whose text matches, with their refs",
    min: 1,
    max: 1,
    shape: "result",
    build: ([text]) => ({ tool: "browser_find", args: { text } }),
  },
  click: {
    synopsis: "<ref> [--double] [--right]",
    summary: "click an element",
    flags: { double: { type: "boolean" }, right: { type: "boolean" } },
    min: 1,
    max: 1,
    shape: "page",
    build: ([target], p) => ({
      tool: "browser_click",
      args: {
        target,
        ...(bool(p, "double") ? { doubleClick: true } : {}),
        ...(bool(p, "right") ? { button: "right" } : {}),
      },
    }),
  },
  type: {
    synopsis: "<ref> <text|-> [--submit] [--slowly]",
    summary: "fill a field (- reads the text from stdin); --submit presses Enter after",
    flags: { submit: { type: "boolean" }, slowly: { type: "boolean" } },
    min: 2,
    max: 2,
    shape: "page",
    build: async ([target, text], p, deps) => ({
      tool: "browser_type",
      args: {
        target,
        text: text === "-" ? (await deps.stdin()).replace(/\r?\n$/, "") : text,
        ...(bool(p, "submit") ? { submit: true } : {}),
        ...(bool(p, "slowly") ? { slowly: true } : {}),
      },
    }),
  },
  press: {
    synopsis: "<key>",
    summary: "press a key (Enter, Escape, ArrowDown, Control+a)",
    min: 1,
    max: 1,
    shape: "page",
    build: ([key]) => ({ tool: "browser_press_key", args: { key } }),
  },
  select: {
    synopsis: "<ref> <value>...",
    summary: "choose options of a select element",
    min: 2,
    max: 50,
    shape: "page",
    build: ([target, ...values]) => ({ tool: "browser_select_option", args: { target, values } }),
  },
  hover: {
    synopsis: "<ref>",
    summary: "move the pointer over an element",
    min: 1,
    max: 1,
    shape: "page",
    build: ([target]) => ({ tool: "browser_hover", args: { target } }),
  },
  wait: {
    synopsis: "[--text <t>] [--gone <t>] [--seconds <n>]",
    summary: "wait for text to appear or go, or for some seconds",
    flags: { text: { type: "string" }, gone: { type: "string" }, seconds: { type: "string" } },
    min: 0,
    max: 0,
    shape: "page",
    build: (_pos, p) => {
      const text = str(p, "text");
      const gone = str(p, "gone");
      const seconds = str(p, "seconds");
      if (text === undefined && gone === undefined && seconds === undefined)
        fail("wait needs --text, --gone or --seconds");
      const time = seconds === undefined ? undefined : Number(seconds);
      if (time !== undefined && !(time >= 0)) fail(`--seconds must be a number, not "${seconds}"`);
      return {
        tool: "browser_wait_for",
        args: {
          ...(text !== undefined ? { text } : {}),
          ...(gone !== undefined ? { textGone: gone } : {}),
          ...(time !== undefined ? { time } : {}),
        },
      };
    },
  },
  screenshot: {
    synopsis: "[--out <file.png>] [--full]",
    summary: "save a PNG of the tab (default: a file in the temporary folder) and print its path",
    flags: { out: { type: "string" }, full: { type: "boolean" } },
    min: 0,
    max: 0,
    shape: "screenshot",
    build: (_pos, p) => ({
      tool: "browser_take_screenshot",
      args: { type: "png", scale: "css", ...(bool(p, "full") ? { fullPage: true } : {}) },
    }),
  },
  tabs: {
    synopsis: "[new [<url>] | select <n> | close <n>]",
    summary: "the browser's tabs (others' marked in use), or open, pick or close one",
    min: 0,
    max: 2,
    shape: "result",
    build: ([what, value]) => {
      if (what === undefined || what === "list") return { tool: "browser_tabs", args: { action: "list" } };
      if (what === "new") return { tool: "browser_tabs", args: { action: "new", ...(value ? { url: value } : {}) } };
      if (what === "select" || what === "close") {
        const index = Number(value);
        if (value === undefined || !Number.isInteger(index) || index < 0)
          fail(`tabs ${what} needs a tab number from 'tabs', for example: tabs ${what} 1`);
        return { tool: "browser_tabs", args: { action: what, index } };
      }
      return fail(`tabs takes new, select <n> or close <n>, not "${what}"`);
    },
  },
  login: {
    synopsis: "<site>",
    summary: "sign in with a vault credential (turno browser vault); the value never reaches the shell",
    min: 1,
    max: 1,
    shape: "result",
    build: ([site]) => ({ tool: "browser_login", args: { site } }),
  },
  call: {
    synopsis: "<tool> [--args <json>] [--arg key=value]...",
    summary: "any tool of the identity's server, in this session (browser_batch, browser_fill_form...)",
    flags: { args: { type: "string" }, arg: { type: "string", multiple: true } },
    min: 1,
    max: 1,
    shape: "raw",
    build: ([tool], p) => ({
      tool: tool!,
      args: callArguments(str(p, "args"), (p.values.arg as string[] | undefined) ?? []),
    }),
  },
  close: {
    synopsis: "",
    summary: "close the session's tabs (the whole browser when it serves one session) and end the session",
    min: 0,
    max: 0,
    shape: "result",
    build: () => ({ tool: "browser_close", args: {} }),
  },
};

/** Actions that make no tool call. */
const LOCAL: Record<string, { synopsis: string; summary: string }> = {
  session: { synopsis: "", summary: "which session these commands use, who owns it and how it ends" },
  end: { synopsis: "", summary: "end the session now: its tabs stay open and free, the browser keeps running" },
};

const COMMON: FlagSpec = {
  session: { type: "string" },
  profile: { type: "string" },
  timeout: { type: "string" },
  snapshot: { type: "boolean" },
  ...JSON_FLAG,
};

/** Every action name with its synopsis and summary, for the help and for completion. */
export const ACTION_NAMES: readonly string[] = [...Object.keys(ACTIONS), ...Object.keys(LOCAL)];

export const DO_FLAG_NAMES: readonly string[] = [
  "--session",
  "--profile",
  "--timeout",
  "--snapshot",
  "--json",
  ...new Set(
    Object.values(ACTIONS)
      .flatMap((a) => Object.keys(a.flags ?? {}))
      .map((f) => `--${f}`),
  ),
];

export const DO_SYNOPSIS = "<id> <action> [args] [--session <name>] [--json]";

export const DO_DETAILS = `Runs one action on the identity's browser through mcpd and turno-browser-mcp, the server
agents use, so the identity's rules apply as they do to an agent's tool call. The identity must
be served by mcpd (its [server.browser-<id>] block in mcp.toml, which turno browser add prints).

Actions:
${columns(
  [
    ...Object.entries(ACTIONS).map(([n, a]) => [`${n}${a.synopsis ? ` ${a.synopsis}` : ""}`, a.summary] as const),
    ...Object.entries(LOCAL).map(([n, a]) => [`${n}${a.synopsis ? ` ${a.synopsis}` : ""}`, a.summary] as const),
  ],
  2,
  40,
)}

Refs (e12) come from the last snapshot; take a new one after the page changes.

Session: the commands one agent or one terminal shell runs are one session, so they keep their
tab and their place in the tab locks ("sharing": "tabs") or hold the identity's one-session lease
("sharing": "session"). The session belongs to the process that runs the commands: the coding
agent (each of its shell commands passes through a short-lived shell) or your terminal's shell.
It ends when that process exits, with 'end' or 'close', or when mcpd restarts. --session <name>
(or TURNO_BROWSER_SESSION) keeps several sessions apart under one owner, for example two
subagents each in its own tab.

Output: url: and title: lines, then what the action returned; errors go to stderr with exit 1.
--snapshot after an action prints the snapshot too; --json prints one object.
--timeout <seconds> (default 120) bounds one action; attach mode can wait for Chrome's consent
dialog. --profile picks the profile whose token and tool filter apply (default: this folder's).`;

const DO_EXAMPLES: readonly string[] = [
  "turno browser do school open https://example.com",
  "turno browser do school snapshot",
  "turno browser do school click e12",
  "turno browser do school type e5 'alice@example.com' --submit",
  "turno browser do school read",
  "turno browser do school screenshot --out page.png",
  "turno browser do school end",
];

function doUsage(): string {
  return `Usage:\n  turno browser do ${DO_SYNOPSIS}\n\n${DO_DETAILS}\n\n${examplesBlock(DO_EXAMPLES)}`;
}

function actionUsage(name: string): string {
  const a = ACTIONS[name] ?? LOCAL[name]!;
  const mine = DO_EXAMPLES.filter((e) => e.split(" ")[4] === name);
  return `Usage:\n  turno browser do <id> ${name}${a.synopsis ? ` ${a.synopsis}` : ""} [--session <name>] [--json]\n\n${a.summary}\n\n${examplesBlock(mine.length ? mine : [`turno browser do school ${name}`])}`;
}

// ---- results ---------------------------------------------------------------------------

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** The sections of an upstream result text (`### Title`, then the body). */
function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = text.split(/^### /m);
  const head = parts[0]!.trim();
  if (head) out.set("", head);
  for (const part of parts.slice(1)) {
    const nl = part.indexOf("\n");
    const title = nl < 0 ? part.trim() : part.slice(0, nl).trim();
    out.set(title, nl < 0 ? "" : part.slice(nl + 1).trim());
  }
  return out;
}

function unfence(body: string): string {
  return body.replace(/^```[a-z]*\n/, "").replace(/\n?```$/, "");
}

function pageOf(parts: Map<string, string>): { url: string; title: string } | null {
  const body = parts.get("Page");
  if (!body) return null;
  const url = /^- Page URL: (.*)$/m.exec(body)?.[1]?.trim() ?? "";
  const title = /^- Page Title: (.*)$/m.exec(body)?.[1]?.trim() ?? "";
  return url || title ? { url, title } : null;
}

/** Upstream's error without the wrapper names and terminal colors. */
function errorText(parts: Map<string, string>, whole: string): string {
  const raw = parts.get("Error") ?? whole;
  return raw
    .replace(ANSI, "")
    .replace(/^(Error: )?browserBackend\.callTool: (Error: )?/, "")
    .trim();
}

/** Notes worth a line: a dialog, new tabs and downloads, what the tab governor did. */
function notesOf(parts: Map<string, string>): string[] {
  const out: string[] = [];
  for (const title of ["Modal state", "Events", "Tab governor", "Downloads"]) {
    const body = parts.get(title);
    if (body)
      out.push(
        ...body
          .split("\n")
          .map((l) => l.replace(/^- /, "").trim())
          .filter(Boolean),
      );
  }
  return out;
}

function textOf(content: ContentItem[]): string {
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

interface Rendered {
  ok: boolean;
  page: { url: string; title: string } | null;
  result: string | null;
  snapshot: string | null;
  file: string | null;
  notes: string[];
  error: string | null;
  /** Lines for stderr in text mode (besides the error). */
  warnings: string[];
}

function render(
  shape: Shape,
  content: ContentItem[],
  isError: boolean,
  opts: { maxChars: number; out?: string | undefined; identity: string },
): Rendered {
  const whole = textOf(content);
  const parts = sections(whole);
  const base: Rendered = {
    ok: !isError,
    page: pageOf(parts),
    result: null,
    snapshot: null,
    file: null,
    notes: notesOf(parts),
    error: null,
    warnings: [],
  };
  if (isError) return { ...base, error: errorText(parts, whole) };
  const result = parts.get("Result");
  switch (shape) {
    case "snapshot": {
      const snap = parts.get("Snapshot");
      return { ...base, snapshot: snap === undefined ? null : unfence(snap) };
    }
    case "read": {
      let text = result ?? "";
      try {
        const v = JSON.parse(text) as unknown;
        text = typeof v === "string" ? v : JSON.stringify(v);
      } catch {
        /* not JSON: as it came */
      }
      if (opts.maxChars > 0 && text.length > opts.maxChars) {
        const full = text.length;
        text = text.slice(0, opts.maxChars);
        base.warnings.push(`text cut at ${opts.maxChars} of ${full} characters (--max-chars 0 for all)`);
      }
      return { ...base, result: text };
    }
    case "screenshot": {
      const image = content.find((c) => c.type === "image" && c.data);
      if (!image) return { ...base, ok: false, error: "the server returned no image" };
      const ext = image.mimeType === "image/jpeg" ? "jpg" : "png";
      const file = resolve(opts.out ?? join(tmpdir(), `turno-${opts.identity}-${Date.now()}.${ext}`));
      writeFileSync(file, Buffer.from(image.data!, "base64"));
      return { ...base, file };
    }
    case "raw":
      return { ...base, result: whole.replace(ANSI, "") || null };
    default:
      return { ...base, result: result ?? null };
  }
}

function printText(io: Io, r: Rendered, json: boolean): void {
  if (json) return;
  if (r.page) {
    io.out(`url: ${r.page.url}`);
    if (r.page.title) io.out(`title: ${r.page.title}`);
  }
  if (r.result !== null && r.result !== "") io.out(r.result);
  if (r.file) io.out(`file: ${r.file}`);
  for (const n of r.notes) io.out(`note: ${n}`);
  if (r.snapshot !== null) io.out(r.snapshot);
  for (const w of r.warnings) io.err(`turno: ${w}`);
  if (r.error) io.err(`error: ${r.error}`);
}

// ---- the gateway session ---------------------------------------------------------------

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

// ---- the command -----------------------------------------------------------------------

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

function sessionInfo(t: Target, resumed: boolean | null) {
  return { name: t.name, ownerPid: t.owner.pid, owner: ownerName(t.owner), resumed };
}

const IDENTITY_ID = /^[a-z0-9][a-z0-9_-]*$/;

/** `turno browser do <id> <action> [args]`. */
export async function browserDo(args: string[], io: Io, deps: DoDeps = defaultDoDeps): Promise<number> {
  const [id, action, ...rest] = args;
  if (id === undefined || id === "--help" || id === "-h" || id === "help") {
    io.out(doUsage());
    return Exit.ok;
  }
  if (!IDENTITY_ID.test(id) || id.length > 64)
    return fail(
      `invalid identity "${id}": use lowercase letters, digits, "-" and "_" (turno browser identities lists them)`,
    );
  if (action === undefined || action.startsWith("-")) {
    if (action === "--help" || action === "-h") {
      io.out(doUsage());
      return Exit.ok;
    }
    return fail(`browser do needs an action: turno browser do ${id} <action> (${ACTION_NAMES.join(", ")})`);
  }
  const act = ACTIONS[action];
  if (!act && !LOCAL[action]) {
    return fail(`unknown action "${action}" (actions: ${ACTION_NAMES.join(", ")}; turno browser do --help)`);
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    io.out(actionUsage(action));
    return Exit.ok;
  }
  const p = parseFlags(rest, { ...COMMON, ...(act?.flags ?? {}) }, act ? act.max : 0);
  if (act && p.positionals.length < act.min)
    return fail(`usage: turno browser do ${id} ${action} ${act.synopsis}`.trimEnd());
  const json = jsonArg(rest) !== undefined;
  const timeoutFlag = str(p, "timeout");
  const timeoutS = timeoutFlag === undefined ? 120 : Number(timeoutFlag);
  if (!(timeoutS > 0)) return fail(`--timeout takes seconds, not "${timeoutFlag}"`);
  const maxChars = int(p, "max-chars") ?? DEFAULT_MAX_CHARS;
  // Build the call before anything connects: a bad argument opens no session.
  const call = act ? await act.build(p.positionals, p, deps) : undefined;

  const t = await resolveTarget(id, p, io, deps);
  sweepSaved(io.env);
  const identity = `browser:${id}`;
  const head = { identity, server: t.server, profile: t.profile };

  if (action === "session") {
    const found = readSaved(t.file);
    const saved = usable(found, t) ? found : undefined;
    const live = saved !== undefined;
    if (json) {
      emit(io, p, DO_JSON, {
        ...head,
        session: sessionInfo(t, live),
        action,
        tool: null,
        ok: true,
        page: null,
        result: live ? "open" : "none",
        snapshot: null,
        file: null,
        notes: [],
        error: null,
      });
      return Exit.ok;
    }
    io.out(`identity: ${identity} (server ${t.server}, profile ${t.profile})`);
    io.out(`session: ${t.name}, owned by ${ownerName(t.owner)} (pid ${t.owner.pid})`);
    io.out(
      saved
        ? `state: open since ${saved.createdAt}, last used ${saved.usedAt}`
        : "state: none yet; the next action opens it",
    );
    io.out(`ends: when pid ${t.owner.pid} exits, with 'end' or 'close', or when mcpd restarts`);
    io.out(`file: ${tildify(t.file, io.env)}`);
    return Exit.ok;
  }

  if (action === "end") {
    const saved = readSaved(t.file);
    if (saved) await endSaved(t, saved);
    dropSaved(t.file);
    if (json) {
      emit(io, p, DO_JSON, {
        ...head,
        session: sessionInfo(t, null),
        action,
        tool: null,
        ok: true,
        page: null,
        result: saved ? "ended" : "none",
        snapshot: null,
        file: null,
        notes: [],
        error: null,
      });
    } else io.out(saved ? `ended session ${t.name} of ${identity}` : `no session ${t.name} of ${identity} to end`);
    return Exit.ok;
  }

  const c = call!;
  return await withLock(t.file, io.env, async () => {
    let saved = readSaved(t.file);
    if (saved && !usable(saved, t)) {
      // Another mcpd, server, profile or owner: that session is not this one's to continue.
      await endSaved(t, saved);
      dropSaved(t.file);
      saved = undefined;
    }
    let resumed = saved !== undefined;
    let conn = await open(t, saved);
    const timeout = timeoutS * 1000;
    const callTool = (name: string, a: Record<string, unknown>) =>
      conn.client.callTool({ name, arguments: a }, undefined, { timeout, resetTimeoutOnProgress: true });
    try {
      let result: Awaited<ReturnType<typeof callTool>>;
      // A session this command opened and could not use (a lease another session holds, a
      // refused call) goes at once instead of waiting for its owner to exit.
      const giveUp = async (err: unknown): Promise<never> => {
        if (!resumed) await conn.transport.terminateSession().catch(() => {});
        throw new CliError(`${c.tool}: ${gatewayMessage(err).message}`);
      };
      try {
        result = await callTool(c.tool, c.args);
      } catch (err) {
        if (!resumed || !sessionGone(err)) return await giveUp(err);
        // mcpd forgot the session (it restarted and could not rebuild it): start a new one.
        await conn.client.close().catch(() => {});
        dropSaved(t.file);
        resumed = false;
        conn = await open(t);
        try {
          result = await callTool(c.tool, c.args);
        } catch (again) {
          return await giveUp(again);
        }
      }
      const closing = action === "close" && result.isError !== true;
      if (closing) {
        await conn.transport.terminateSession().catch(() => {});
        dropSaved(t.file);
      } else writeSaved(t.file, freshSaved(t, conn.transport, saved), io.env);

      const content = (Array.isArray(result.content) ? result.content : []) as ContentItem[];
      const r = render(act!.shape, content, result.isError === true, {
        maxChars,
        out: str(p, "out"),
        identity: id,
      });
      if (r.ok && bool(p, "snapshot") && act!.shape === "page" && !closing) {
        const snap = await callTool("browser_snapshot", {}).catch(() => undefined);
        const sc = (Array.isArray(snap?.content) ? snap.content : []) as ContentItem[];
        const s = render("snapshot", sc, snap?.isError === true, { maxChars, identity: id });
        r.snapshot = s.snapshot;
        if (s.page) r.page = s.page;
      }
      if (json)
        emit(io, p, DO_JSON, {
          ...head,
          session: sessionInfo(t, resumed),
          action,
          tool: c.tool,
          ok: r.ok,
          page: r.page,
          result: r.result,
          snapshot: r.snapshot,
          file: r.file,
          notes: r.notes,
          error: r.error,
        });
      printText(io, r, json);
      return r.ok ? Exit.ok : Exit.failure;
    } finally {
      // Never terminateSession here: the next command of this session reconnects to it.
      await conn.client.close().catch(() => {});
    }
  });
}

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CliError,
  Exit,
  type FlagSpec,
  type Io,
  JSON_FLAG,
  type Parsed,
  bool,
  callArguments,
  columns,
  emit,
  examplesBlock,
  fail,
  jsonArg,
  jsonOutput,
  parseFlags,
  str,
} from "turno-core/cli";
import type { Ctx } from "./context.js";

/**
 * `<browser> do <id> <action>`: one browser action on an identity's browser from the shell, for
 * coding agents that prefer commands over MCP tools. Each action is one stock (or turno) tool call
 * to the identity's turno-browser-mcp, the server agents use, so every rule of the identity
 * applies as it does to an agent: the tab locks or the one-session lease, attach mode, read mode's
 * refusals, humanize, recordings, the vault. How the call reaches the server, and what makes
 * several commands one session, is the host's transport (`DoTransport`): inside turno, mcpd.
 *
 * The output is short and stable: `url:` and `title:` lines, then what the action returned. The
 * code upstream ran and the snapshot file an action saves on the server are left out; a snapshot
 * comes from `snapshot` (or `--snapshot` after an action).
 */

/** `do --json`: one object per command. */
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

/** A tool call's result as an MCP client returns it. */
export interface ToolResult {
  content?: unknown;
  isError?: boolean | undefined;
}

/** One item of a tool result's content. */
interface ContentItem {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
}

/** The `session` field of `do --json`. */
export interface DoSessionInfo {
  name: string;
  ownerPid: number;
  owner: string;
  /** True when the command continued a saved session, false when it opened one, null for `end`. */
  resumed: boolean | null;
}

/** One session of `do`, open for one command. */
export interface DoSession {
  /** True when this continues a session an earlier command opened. */
  readonly resumed: boolean;
  /**
   * Call one tool in the session, within `timeoutMs`. A call the server refuses or cannot take
   * throws a CliError that names the tool; the session is kept for the next command.
   */
  call(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolResult>;
  /** End the session now (after `close`): the next command opens a new one. */
  end(): Promise<void>;
}

/** The server of one identity and the session the commands of this shell or agent belong to. */
export interface DoTarget {
  /** What every `--json` object starts with: the identity, and the server and profile when there are. */
  head: { identity: string; server: string | null; profile: string | null };
  /** The `session` field of `--json`. */
  info(resumed: boolean | null): DoSessionInfo;
  /** `do <id> session`: whether a session is saved, and the lines that describe it. */
  describe(io: Io): { open: boolean; lines: string[] };
  /** `do <id> end`: end the saved session at once; false when there was none. */
  end(): Promise<boolean>;
  /** Open a session, or continue the saved one, run `fn` in it, and keep it for the next command. */
  session<T>(fn: (s: DoSession) => Promise<T>): Promise<T>;
}

/**
 * How `do` reaches an identity's server: inside turno, mcpd (each command one gateway session of
 * the profile); on its own, a background server per identity.
 */
export interface DoTransport {
  /** Help paragraphs: how an action reaches the server, how a session lives, the output and flags. */
  help: { intro: string; session: string; output: string };
  /** Flags of its own (turno's `--profile`), parsed with the action's. */
  flags: FlagSpec;
  /** The server that serves identity `id`, and this caller's session; throws when there is none. */
  target(id: string, p: Parsed, io: Io): Promise<DoTarget>;
}

/** The generic paragraph about output and flags, for a transport without flags of its own. */
const DO_OUTPUT = `Output: url: and title: lines, then what the action returned; errors go to stderr with exit 1.
--snapshot after an action prints the snapshot too; --json prints one object.
--timeout <seconds> (default 120) bounds one action; attach mode can wait for Chrome's consent
dialog.`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

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
  build(pos: string[], p: Parsed, stdin: () => Promise<string>): Call | Promise<Call>;
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
    build: async ([target, text], p, stdin) => ({
      tool: "browser_type",
      args: {
        target,
        text: text === "-" ? (await stdin()).replace(/\r?\n$/, "") : text,
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
    summary: "sign in with a vault credential (<browser> vault); the value never reaches the shell",
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

/**
 * Notes worth a line: a pause by the user (the live view: how long, what changed while the
 * command waited), a dialog, new tabs and downloads, what the tab governor did.
 */
function notesOf(parts: Map<string, string>): string[] {
  const out: string[] = [];
  for (const title of ["Paused by the user", "Modal state", "Events", "Tab governor", "Downloads"]) {
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

function printText(io: Io, r: Rendered, json: boolean, program: string): void {
  if (json) return;
  if (r.page) {
    io.out(`url: ${r.page.url}`);
    if (r.page.title) io.out(`title: ${r.page.title}`);
  }
  if (r.result !== null && r.result !== "") io.out(r.result);
  if (r.file) io.out(`file: ${r.file}`);
  for (const n of r.notes) io.out(`note: ${n}`);
  if (r.snapshot !== null) io.out(r.snapshot);
  for (const w of r.warnings) io.err(`${program}: ${w}`);
  if (r.error) io.err(`error: ${r.error}`);
}

// ---- help --------------------------------------------------------------------------------

const COMMON: FlagSpec = {
  session: { type: "string" },
  timeout: { type: "string" },
  snapshot: { type: "boolean" },
  ...JSON_FLAG,
};

/** Every action name, for the short form and for completion. */
export const ACTION_NAMES: readonly string[] = [...Object.keys(ACTIONS), ...Object.keys(LOCAL)];

/** The flags of `do`, for completion: the common ones, the transport's, then the actions'. */
export function doFlagNames(c: Ctx): string[] {
  return [
    "--session",
    ...Object.keys(c.host.doTransport?.flags ?? {}).map((f) => `--${f}`),
    "--timeout",
    "--snapshot",
    "--json",
    ...new Set(
      Object.values(ACTIONS)
        .flatMap((a) => Object.keys(a.flags ?? {}))
        .map((f) => `--${f}`),
    ),
  ];
}

export function doSynopsis(_c: Ctx): string {
  return "<id> <action> [args] [--session <name>] [--json]";
}

/** An action's summary, with the host's command names. */
function summaryOf(c: Ctx, summary: string): string {
  return summary.replace("<browser>", c.names.browser);
}

/** What `do` says when the host has no transport: turno-browser on its own, for now. */
function noTransport(c: Ctx): string {
  return `${c.names.browser} do needs turno for now: run \`turno browser do <id> <action>\` (turno-cli), which reaches the identity's browser through its gateway. A standalone mode is coming.`;
}

export function doDetails(c: Ctx): string {
  const t = c.host.doTransport;
  const actions = `Actions:
${columns(
  [
    ...Object.entries(ACTIONS).map(
      ([n, a]) => [`${n}${a.synopsis ? ` ${a.synopsis}` : ""}`, summaryOf(c, a.summary)] as const,
    ),
    ...Object.entries(LOCAL).map(([n, a]) => [`${n}${a.synopsis ? ` ${a.synopsis}` : ""}`, a.summary] as const),
  ],
  2,
  40,
)}

Refs (e12) come from the last snapshot; take a new one after the page changes.`;
  if (!t) return `${noTransport(c)}\n\n${actions}\n\n${DO_OUTPUT}`;
  return `${t.help.intro}\n\n${actions}\n\n${t.help.session}\n\n${t.help.output}`;
}

function doExamples(c: Ctx): string[] {
  const b = c.names.browser;
  return [
    `${b} do school open https://example.com`,
    `${b} do school snapshot`,
    `${b} do school click e12`,
    `${b} do school type e5 'alice@example.com' --submit`,
    `${b} do school read`,
    `${b} do school screenshot --out page.png`,
    `${b} do school end`,
  ];
}

function doUsage(c: Ctx): string {
  return `Usage:\n  ${c.names.browser} do ${doSynopsis(c)}\n\n${doDetails(c)}\n\n${examplesBlock(doExamples(c))}`;
}

function actionUsage(c: Ctx, name: string): string {
  const a = ACTIONS[name] ?? LOCAL[name]!;
  // The action is the word after `<browser> do <id>`.
  const at = c.names.browser.split(" ").length + 2;
  const mine = doExamples(c).filter((e) => e.split(" ")[at] === name);
  return `Usage:\n  ${c.names.browser} do <id> ${name}${a.synopsis ? ` ${a.synopsis}` : ""} [--session <name>] [--json]\n\n${summaryOf(c, a.summary)}\n\n${examplesBlock(mine.length ? mine : [`${c.names.browser} do school ${name}`])}`;
}

// ---- the command -----------------------------------------------------------------------

const IDENTITY_ID = /^[a-z0-9][a-z0-9_-]*$/;

/** `<browser> do <id> <action> [args]`. */
export async function browserDo(c: Ctx, args: string[], io: Io): Promise<number> {
  const b = c.names.browser;
  const [id, action, ...rest] = args;
  if (id === undefined || id === "--help" || id === "-h" || id === "help") {
    io.out(doUsage(c));
    return Exit.ok;
  }
  const lister = c.names.subject ? `${b} identities` : `${b} list`;
  if (!IDENTITY_ID.test(id) || id.length > 64)
    return fail(`invalid identity "${id}": use lowercase letters, digits, "-" and "_" (${lister} lists them)`);
  if (action === undefined || action.startsWith("-")) {
    if (action === "--help" || action === "-h") {
      io.out(doUsage(c));
      return Exit.ok;
    }
    return fail(`${c.names.subject}do needs an action: ${b} do ${id} <action> (${ACTION_NAMES.join(", ")})`);
  }
  const act = ACTIONS[action];
  if (!act && !LOCAL[action]) {
    return fail(`unknown action "${action}" (actions: ${ACTION_NAMES.join(", ")}; ${b} do --help)`);
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    io.out(actionUsage(c, action));
    return Exit.ok;
  }
  const transport = c.host.doTransport;
  if (!transport) throw new CliError(noTransport(c));
  const p = parseFlags(rest, { ...COMMON, ...transport.flags, ...(act?.flags ?? {}) }, act ? act.max : 0);
  if (act && p.positionals.length < act.min) return fail(`usage: ${b} do ${id} ${action} ${act.synopsis}`.trimEnd());
  const json = jsonArg(rest) !== undefined;
  const timeoutFlag = str(p, "timeout");
  const timeoutS = timeoutFlag === undefined ? 120 : Number(timeoutFlag);
  if (!(timeoutS > 0)) return fail(`--timeout takes seconds, not "${timeoutFlag}"`);
  const maxChars = int(p, "max-chars") ?? DEFAULT_MAX_CHARS;
  // Build the call before anything connects: a bad argument opens no session.
  const call = act ? await act.build(p.positionals, p, c.deps.stdin ?? readStdin) : undefined;

  const t = await transport.target(id, p, io);
  const head = t.head;
  const blank = { tool: null, ok: true, page: null, snapshot: null, file: null, notes: [], error: null };

  if (action === "session") {
    const { open, lines } = t.describe(io);
    if (json) {
      emit(io, p, DO_JSON, { ...head, session: t.info(open), action, ...blank, result: open ? "open" : "none" });
      return Exit.ok;
    }
    for (const l of lines) io.out(l);
    return Exit.ok;
  }

  if (action === "end") {
    const ended = await t.end();
    const { name } = t.info(null);
    if (json)
      emit(io, p, DO_JSON, { ...head, session: t.info(null), action, ...blank, result: ended ? "ended" : "none" });
    else io.out(ended ? `ended session ${name} of ${head.identity}` : `no session ${name} of ${head.identity} to end`);
    return Exit.ok;
  }

  const cl = call!;
  const timeout = timeoutS * 1000;
  return await t.session(async (s) => {
    const result = await s.call(cl.tool, cl.args, timeout);
    const closing = action === "close" && result.isError !== true;
    if (closing) await s.end();
    const content = (Array.isArray(result.content) ? result.content : []) as ContentItem[];
    const r = render(act!.shape, content, result.isError === true, {
      maxChars,
      out: str(p, "out"),
      identity: id,
    });
    if (r.ok && bool(p, "snapshot") && act!.shape === "page" && !closing) {
      const snap = await s.call("browser_snapshot", {}, timeout).catch(() => undefined);
      const sc = (Array.isArray(snap?.content) ? snap.content : []) as ContentItem[];
      const sr = render("snapshot", sc, snap?.isError === true, { maxChars, identity: id });
      r.snapshot = sr.snapshot;
      if (sr.page) r.page = sr.page;
    }
    if (json)
      emit(io, p, DO_JSON, {
        ...head,
        session: t.info(s.resumed),
        action,
        tool: cl.tool,
        ok: r.ok,
        page: r.page,
        result: r.result,
        snapshot: r.snapshot,
        file: r.file,
        notes: r.notes,
        error: r.error,
      });
    printText(io, r, json, c.names.program);
    return r.ok ? Exit.ok : Exit.failure;
  });
}

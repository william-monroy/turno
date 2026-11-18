/**
 * Choose a profile when a command needs one and the argument is missing. A small
 * picker with no dependencies: arrow keys or j/k move, typing filters, Enter chooses, Esc or
 * Ctrl-C cancels. It draws on stderr and reads stdin in raw mode, only when both are terminals;
 * the terminal is restored on every way out (a choice, a cancel, an error, a signal).
 *
 * Where nobody can answer (no terminal, --no-input, an agent session: `io.ask` is unset) the
 * command fails with exit 2 and the valid values instead.
 *
 * The key handling is a pure state machine (`parseKeys`, `reduce`), so tests drive it without a
 * terminal. Loaded lazily by the commands that use it.
 */
import { Exit } from "./exit.js";
import { type AgentId, DEFAULT_AGENT, adapter } from "../agents/index.js";
import { loadConfig } from "../core/config.js";
import { exhaustedUntil } from "../core/exhausted.js";
import { agentOf, listProfiles } from "../core/profiles.js";
import { candidateRoots, resolveProfile } from "../core/resolve.js";
import { CliError, type Io, fail, needsAnswer } from "./io.js";
import { launcherPath } from "./launch.js";
import { type Style, profileColor, style, visibleWidth } from "./style.js";

/** One choice: its value, the cells drawn for it, and the text the filter searches. */
export interface PickItem {
  value: string;
  cells: string[];
  search: string;
}

export interface PickState {
  items: readonly PickItem[];
  query: string;
  /** Index into the items that match the query. */
  cursor: number;
}

export type PickKey =
  | { name: "up" | "down" | "pageUp" | "pageDown" | "home" | "end" | "enter" | "cancel" | "backspace" | "clear" }
  | { name: "char"; ch: string };

export type Outcome = { kind: "pick"; value: string } | { kind: "cancel" };

/** Rows a page key moves. */
const PAGE = 5;

/** Items that match the query: the name first, then the other fields; case does not matter. */
export function matching(state: Pick<PickState, "items" | "query">): PickItem[] {
  const q = state.query.trim().toLowerCase();
  if (!q) return [...state.items];
  const byName = state.items.filter((i) => i.value.toLowerCase().includes(q));
  const byOther = state.items.filter((i) => !byName.includes(i) && i.search.toLowerCase().includes(q));
  return [...byName, ...byOther];
}

/** The first state: the cursor on `initial` when it is one of the items. */
export function initialState(items: readonly PickItem[], initial?: string): PickState {
  return {
    items,
    query: "",
    cursor: Math.max(
      0,
      items.findIndex((i) => i.value === initial),
    ),
  };
}

/** The item under the cursor, if any matches. */
export function selected(state: PickState): PickItem | undefined {
  return matching(state)[state.cursor];
}

/** The same state with new items (accounts arrived), the cursor kept on the same value. */
export function withItems(state: PickState, items: readonly PickItem[]): PickState {
  const value = selected(state)?.value;
  const next = { ...state, items };
  const idx = matching(next).findIndex((i) => i.value === value);
  return { ...next, cursor: Math.max(0, idx) };
}

/** A new query: the cursor stays on the same item while it still matches, else goes to the first. */
function requery(state: PickState, query: string): PickState {
  const value = selected(state)?.value;
  const next = { ...state, query };
  const idx = matching(next).findIndex((i) => i.value === value);
  return { ...next, cursor: Math.max(0, idx) };
}

/**
 * One key applied to the state. j and k move while the filter is empty (once typing starts they
 * are letters); arrows and Ctrl-N/Ctrl-P always move. Enter with nothing matching does nothing.
 */
export function reduce(state: PickState, key: PickKey): { state: PickState; outcome?: Outcome } {
  const n = matching(state).length;
  const move = (to: number) => ({ state: { ...state, cursor: n ? Math.min(Math.max(to, 0), n - 1) : 0 } });
  switch (key.name) {
    case "up":
      return move(state.cursor - 1 < 0 ? n - 1 : state.cursor - 1);
    case "down":
      return move(state.cursor + 1 >= n ? 0 : state.cursor + 1);
    case "pageUp":
      return move(state.cursor - PAGE);
    case "pageDown":
      return move(state.cursor + PAGE);
    case "home":
      return move(0);
    case "end":
      return move(n - 1);
    case "cancel":
      return { state, outcome: { kind: "cancel" } };
    case "enter": {
      const item = selected(state);
      return item ? { state, outcome: { kind: "pick", value: item.value } } : { state };
    }
    case "backspace":
      return { state: requery(state, [...state.query].slice(0, -1).join("")) };
    case "clear":
      return { state: requery(state, "") };
    case "char":
      if (!state.query && (key.ch === "j" || key.ch === "k"))
        return reduce(state, { name: key.ch === "j" ? "down" : "up" });
      if (!state.query && key.ch === " ") return { state };
      return { state: requery(state, state.query + key.ch) };
  }
}

const CSI_KEYS: Record<string, PickKey["name"]> = {
  A: "up",
  B: "down",
  H: "home",
  F: "end",
  "1~": "home",
  "7~": "home",
  "4~": "end",
  "8~": "end",
  "5~": "pageUp",
  "6~": "pageDown",
};

/**
 * Keys in a chunk of raw terminal input. A lone Esc (no sequence after it) cancels; escape
 * sequences the picker does not use are skipped whole.
 */
export function parseKeys(chunk: string): PickKey[] {
  const keys: PickKey[] = [];
  const chars = [...chunk];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === "\x1b") {
      const next = chars[i + 1];
      if (next === "[" || next === "O") {
        let j = i + 2;
        let params = "";
        while (j < chars.length && /[0-9;]/.test(chars[j]!)) params += chars[j++];
        const final = chars[j] ?? "";
        const name = CSI_KEYS[final === "~" ? `${params}~` : final];
        if (name) keys.push({ name } as PickKey);
        i = j;
        continue;
      }
      keys.push({ name: "cancel" });
      // Alt+key arrives as Esc then the key: both belong to the cancel.
      if (next !== undefined) i++;
      continue;
    }
    if (c === "\r" || c === "\n") keys.push({ name: "enter" });
    else if (c === "\x03" || c === "\x04") keys.push({ name: "cancel" });
    else if (c === "\x7f" || c === "\b") keys.push({ name: "backspace" });
    else if (c === "\x15") keys.push({ name: "clear" });
    else if (c === "\x0e") keys.push({ name: "down" });
    else if (c === "\x10") keys.push({ name: "up" });
    else if (c === "\t") keys.push({ name: "down" });
    else if (c >= " ") keys.push({ name: "char", ch: c });
  }
  return keys;
}

export interface RenderOptions {
  title: string;
  /** Rows of items shown at once; the list scrolls past it. */
  maxRows: number;
}

/** The picker as lines: a title (with the filter), the matching rows, then the keys. */
export function renderPicker(state: PickState, s: Style, opts: RenderOptions): string[] {
  const shown = matching(state);
  const ascii = s.icons === "ascii";
  const pointer = ascii ? ">" : s.accent("❯");
  const blank = " ".repeat(visibleWidth(pointer));
  const title = `${s.accent("?")} ${s.bold(opts.title)}`;
  const out = [state.query ? `${title}  ${s.muted("filter")} ${state.query}${s.muted("_")}` : title];
  const rows = Math.max(1, opts.maxRows);
  const start = Math.max(0, Math.min(state.cursor - Math.floor(rows / 2), shown.length - rows));
  const page = shown.slice(start, start + rows);
  if (!shown.length) out.push(`  ${s.muted(`no profile matches "${state.query}"`)}`);
  const cells = page.map((item, k) => {
    const on = start + k === state.cursor;
    const [name = "", ...rest] = item.cells;
    return [`${on ? pointer : blank} ${name}`, ...rest.map((c) => (on ? c : s.muted(c)))];
  });
  // The agent column goes first on a narrow terminal, then the account; the mark stays.
  out.push(...s.table(cells, { indent: 1, columns: [{}, { drop: 2 }, { drop: 1 }, {}] }));
  const hidden = shown.length - page.length;
  if (hidden > 0) out.push(`  ${s.muted(`${hidden} more`)}`);
  const hint = ascii
    ? "up/down or j/k move, type to filter, enter choose, esc cancel"
    : "↑↓ or j/k move · type to filter · enter choose · esc cancel";
  out.push(`  ${s.muted(hint)}`);
  return out;
}

/** The terminal the picker draws on and reads keys from. */
export interface Terminal {
  columns(): number;
  rows(): number;
  write(text: string): void;
  /**
   * Start raw input: `onData` gets each chunk of keys. Returns the function that puts the
   * terminal back as it was; it runs once, also when a signal ends the process first.
   */
  start(onData: (chunk: string) => void, onResize?: () => void): () => void;
}

type RawInput = NodeJS.EventEmitter & {
  isRaw?: boolean;
  setRawMode(mode: boolean): unknown;
  setEncoding(enc: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
};
type Output = NodeJS.EventEmitter & { columns?: number; rows?: number; write(text: string): unknown };
type Proc = Pick<NodeJS.Process, "on" | "off" | "kill" | "pid">;

const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";
const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * The real terminal: raw stdin, drawing on stderr. A signal while the picker is open restores
 * the terminal (raw mode off, cursor shown) and then ends the process as the signal would.
 */
export function realTerminal(
  input: RawInput = process.stdin as unknown as RawInput,
  output: Output = process.stderr,
  proc: Proc = process,
): Terminal {
  return {
    columns: () => output.columns || 80,
    rows: () => output.rows || 24,
    write: (text) => {
      output.write(text);
    },
    start(onData, onResize) {
      const wasRaw = Boolean(input.isRaw);
      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        input.off("data", onData);
        if (onResize) output.off("resize", onResize);
        for (const sig of SIGNALS) proc.off(sig, onSignal);
        proc.off("exit", restore);
        try {
          input.setRawMode(wasRaw);
        } catch {
          /* the terminal is gone */
        }
        input.pause();
        output.write(SHOW_CURSOR);
      };
      const onSignal = (sig: NodeJS.Signals) => {
        restore();
        proc.kill(proc.pid, sig);
      };
      for (const sig of SIGNALS) proc.on(sig, onSignal);
      proc.on("exit", restore);
      try {
        input.setRawMode(true);
        input.setEncoding("utf8");
        input.on("data", onData);
        if (onResize) output.on("resize", onResize);
        input.resume();
      } catch (err) {
        restore();
        throw err;
      }
      return restore;
    },
  };
}

/** Physical rows `lines` take on a terminal `columns` wide (long lines wrap). */
function physicalRows(lines: string[], columns: number): number {
  return lines.reduce((n, l) => n + Math.max(1, Math.ceil(visibleWidth(l) / Math.max(1, columns))), 0);
}

export interface RunOptions extends RenderOptions {
  initial?: string;
  /** Items that replace the first ones when ready (accounts looked up after the first draw). */
  update?: Promise<readonly PickItem[]>;
  /** The line left on the terminal after a choice; nothing is left after a cancel. */
  chosen?: (value: string) => string;
  /** The style for a terminal this many columns wide, so a resize redraws to the new width. */
  styleAt?: (columns: number) => Style;
}

/**
 * Run the picker on `term`. Resolves with the chosen value, or undefined when cancelled. The
 * picker's lines are erased at the end, and the terminal is restored on every path.
 */
export function runPicker(
  term: Terminal,
  s: Style,
  items: readonly PickItem[],
  opts: RunOptions,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    let state = initialState(items, opts.initial);
    let drawn = 0;
    let done = false;
    let stop: (() => void) | undefined;
    const erase = () => {
      if (drawn > 0) term.write(`\r${drawn > 1 ? `\x1b[${drawn - 1}A` : ""}\x1b[J`);
      drawn = 0;
    };
    const draw = () => {
      const maxRows = Math.max(3, Math.min(opts.maxRows, term.rows() - 4));
      const lines = renderPicker(state, opts.styleAt ? opts.styleAt(term.columns()) : s, { ...opts, maxRows });
      erase();
      term.write(lines.join("\n"));
      drawn = physicalRows(lines, term.columns());
    };
    const finish = (err: unknown, value?: string) => {
      if (done) return;
      done = true;
      try {
        erase();
        if (value !== undefined && opts.chosen) term.write(`${opts.chosen(value)}\n`);
      } catch {
        /* restoring matters more than the last line */
      }
      try {
        term.write(SHOW_CURSOR);
      } catch {
        /* ditto */
      }
      try {
        stop?.();
      } catch {
        /* ditto */
      }
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      if (done) return;
      try {
        for (const key of parseKeys(chunk)) {
          const r = reduce(state, key);
          state = r.state;
          if (r.outcome) return finish(undefined, r.outcome.kind === "pick" ? r.outcome.value : undefined);
        }
        draw();
      } catch (err) {
        finish(err);
      }
    };
    const redraw = () => {
      if (done) return;
      try {
        draw();
      } catch (err) {
        finish(err);
      }
    };
    try {
      term.write(HIDE_CURSOR);
      stop = term.start(onData, redraw);
      draw();
    } catch (err) {
      finish(err);
      return;
    }
    opts.update?.then(
      (next) => {
        if (done) return;
        state = withItems(state, next);
        redraw();
      },
      () => {
        /* keep the first items */
      },
    );
  });
}

/** What a command tells the picker. */
export interface PickProfileOptions {
  /** The command after `turno`, for the message when nobody can answer (`profile assign`). */
  command: string;
  /** The question at the top: "Profile for ~/code/acme". */
  title: string;
  /** Only this agent's profiles (session handoff takes Claude Code profiles). */
  agent?: AgentId;
  /** The folder whose profile is marked (the current folder by default). */
  dir?: string;
  /** Other marks, by profile: `{ work: "this session" }`. */
  marks?: Record<string, string>;
  /** Other values the command accepts, for the message (`auto`). */
  extra?: string[];
  /** Where the cursor starts; the folder's profile by default. */
  initial?: string;
  /**
   * Offer `auto` first, named with the profile it resolves to here ("auto (work)"), when the
   * folder resolves to one of Claude Code's profiles (`turno run`). The cursor starts on it.
   */
  auto?: boolean;
}

/** An Io that may carry the terminal to use (tests pass a fake one). */
export type PickIo = Io & { terminal?: Terminal };

/** "alice@example.com", "not logged in", or the launcher of an agent without account details. */
async function accountText(
  name: string,
  agent: AgentId,
  env: NodeJS.ProcessEnv,
): Promise<{ text: string; warn: boolean }> {
  if (!launcherPath(name, env, agent)) return { text: "not set up", warn: true };
  // turno reads no account for these agents (Codex, Copilot, Cursor).
  if (!adapter(agent).accountDetails) return { text: "-", warn: false };
  const { authStatus } = await import("./commands/usage.js");
  const s = await authStatus(name, env);
  if (!s) return { text: "account unknown", warn: true };
  return s.loggedIn ? { text: s.email || "logged in", warn: false } : { text: "not logged in", warn: true };
}

/**
 * The profile a command needs, chosen by a person. Without anyone to answer it fails with exit
 * 2 and the valid values; a cancel fails with exit 130 and nothing changed.
 */
export async function pickProfile(io: PickIo, opts: PickProfileOptions): Promise<string> {
  const config = loadConfig(io.env);
  const names = listProfiles(config, io.env, opts.agent);
  if (!names.length)
    return fail(
      `no profiles yet${opts.agent && opts.agent !== DEFAULT_AGENT ? ` for ${adapter(opts.agent).label}` : ""}; create one with turno profile add <name>`,
    );
  if (!io.ask) return needsAnswer(opts.command, `a profile: ${[...names, ...(opts.extra ?? [])].join(", ")}`);

  const dir = opts.dir ?? process.cwd();
  const roots = candidateRoots(dir);
  const agents = [...new Set(names.map((n) => agentOf(n, config)))];
  const here = new Map<string, true>();
  for (const agent of agents) {
    const chosen = resolveProfile(dir, config, io.env, roots, agent).chosen;
    if (chosen) here.set(chosen, true);
  }
  const folderPick =
    names.find((n) => here.has(n) && agentOf(n, config) === DEFAULT_AGENT) ?? names.find((n) => here.has(n));
  // What `turno auto` would open here (Claude Code, as `turno run auto` does).
  const auto = opts.auto ? resolveProfile(dir, config, io.env, roots, DEFAULT_AGENT) : undefined;
  const autoTo = auto?.chosen && names.includes(auto.chosen) ? auto.chosen : undefined;
  const initial = opts.initial && names.includes(opts.initial) ? opts.initial : autoTo ? "auto" : folderPick;

  const term = io.terminal ?? (process.stdin.isTTY && process.stderr.isTTY ? realTerminal() : undefined);
  const styleAt = (columns: number) => style({ env: { ...io.env, COLUMNS: String(columns) }, isTty: true });
  const s = term ? styleAt(term.columns()) : style({ env: io.env, isTty: Boolean(process.stderr.isTTY) });
  const pill = (n: string) => s.profile(n, profileColor(config.profiles, n));
  const now = Date.now() / 1000;
  const mark = (n: string) => {
    const parts: string[] = [];
    if (here.has(n)) parts.push(s.lead("on", "this folder"));
    if (opts.marks?.[n]) parts.push(opts.marks[n]!);
    const until = exhaustedUntil(n, io.env);
    if (until !== undefined && until > now) parts.push(s.warn("exhausted"));
    return parts.join(s.muted(" · "));
  };
  const item = (n: string, account?: { text: string; warn: boolean }): PickItem => {
    const agent = adapter(agentOf(n, config));
    const acc = account ? (account.warn ? s.warn(account.text) : account.text) : s.muted("...");
    return { value: n, cells: [pill(n), agent.label, acc, mark(n)], search: `${agent.label} ${account?.text ?? ""}` };
  };
  const autoName = (st: Style) => `${st.bold("auto")} ${st.muted("(")}${autoTo}${st.muted(")")}`;
  const first: PickItem[] = autoTo
    ? [
        {
          value: "auto",
          cells: [
            autoName(s),
            adapter(DEFAULT_AGENT).label,
            s.muted(auto!.reason),
            auto!.note ? s.warn(`${auto!.assigned} ${auto!.note}`) : "",
          ],
          search: `auto ${autoTo}`,
        },
      ]
    : [];
  const withAccounts = Promise.all(
    names.map(async (n) => item(n, await accountText(n, agentOf(n, config), io.env))),
  ).then((items) => [...first, ...items]);

  let value: string | undefined;
  if (term) {
    value = await runPicker(term, s, [...first, ...names.map((n) => item(n))], {
      title: opts.title,
      maxRows: 10,
      ...(initial ? { initial } : {}),
      update: withAccounts,
      styleAt,
      chosen: (v) => `${s.icon("ok")} ${opts.title} ${v === "auto" && autoTo ? autoName(s) : pill(v)}`,
    });
  } else {
    value = await askByNumber(io, s, await withAccounts, opts.title, initial);
  }
  if (value === undefined) throw new CliError("cancelled; nothing changed", Exit.cancelled);
  return value;
}

/**
 * The picker as a numbered question, for a person who can answer but not on a raw terminal
 * (an `ask` without a TTY on stdin): a number, a name, or Enter for the marked one.
 */
async function askByNumber(
  io: PickIo,
  s: Style,
  items: PickItem[],
  title: string,
  initial: string | undefined,
): Promise<string | undefined> {
  io.err(`${s.accent("?")} ${s.bold(title)}`);
  const rows = items.map((it, i) => [s.muted(String(i + 1)), ...it.cells]);
  for (const line of s.table(rows, { columns: [{ align: "right" }] })) io.err(line);
  const def = initial ? items.findIndex((i) => i.value === initial) + 1 : 0;
  const answer = (await io.ask!(`Number or name${def ? ` [${def}]` : ""}: `)).trim();
  if (!answer) return def ? items[def - 1]!.value : undefined;
  const n = Number(answer);
  if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1]!.value;
  const named = items.find((i) => i.value === answer);
  if (named) return named.value;
  return fail(`no profile '${answer}'; pass a profile: ${items.map((i) => i.value).join(", ")}`);
}

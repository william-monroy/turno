/**
 * Syntax highlighting for what turno shows in a terminal: TOML (config.toml, mcp.toml and their
 * diffs) and JSON (`--json` output, agent config snippets). Both work line by line on the text as
 * it is, never reformat it, and only add ANSI color codes: removing them gives back the input.
 * Callers decide whether to color (see `colors` in io.ts).
 */

const RESET = "\x1b[0m";

/** SGR codes. Magenta reads well on dark and light backgrounds, unlike bright yellow or blue. */
const STYLE = {
  header: "1",
  key: "36",
  string: "32",
  literal: "35",
  comment: "2",
  secret: "33",
} as const;

type Kind = keyof typeof STYLE | "plain";

interface Token {
  text: string;
  kind: Kind;
}

function render(tokens: readonly Token[]): string {
  let out = "";
  for (const t of tokens) {
    if (!t.text) continue;
    out += t.kind === "plain" ? t.text : `\x1b[${STYLE[t.kind]}m${t.text}${RESET}`;
  }
  return out;
}

/** The trailing comment `turno mcp import` adds to a preview line whose value it masked. */
const SECRET_MARK = /^#\s*secret, hidden\s*$/;

// TOML ----------------------------------------------------------------------------------------

const BARE = "[A-Za-z0-9_-]+";
const BASIC = '"(?:[^"\\\\]|\\\\.)*"';
const LITERAL = "'[^']*'";
const SIMPLE = `(?:${BARE}|${BASIC}|${LITERAL})`;
const KEY_PATH = `${SIMPLE}(?:[ \\t]*\\.[ \\t]*${SIMPLE})*`;
/** A key (dotted or quoted) followed by `=`, at the start of what is left of the line. */
const KEY = new RegExp(`^${KEY_PATH}(?=[ \\t]*=)`);
/** `[table]` or `[[array.of.tables]]`, possibly indented, with only a comment after it. */
const HEADER = new RegExp(`^([ \\t]*)(\\[\\[?[ \\t]*${KEY_PATH}[ \\t]*\\]\\]?)(?=[ \\t]*(?:#.*)?$)`);
/** Numbers, booleans, dates and times, inf and nan: anything bare in a value position. */
const WORD = /^[A-Za-z0-9_+\-.:]+/;

/**
 * State carried from one line to the next: open arrays and inline tables (multi-line arrays),
 * and an open multi-line string.
 */
export interface TomlState {
  stack: ("[" | "{")[];
  multiline?: '"""' | "'''";
}

export function tomlState(): TomlState {
  return { stack: [] };
}

/** Where a multi-line string that starts at `from` ends (index after the delimiter), or -1. */
function closeMultiline(line: string, from: number, delim: '"""' | "'''"): number {
  let i = from;
  while (i < line.length) {
    if (delim === '"""' && line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line.startsWith(delim, i)) {
      // A closing delimiter may carry up to two more quotes that belong to the string.
      let end = i + 3;
      while (end < line.length && end - i < 5 && line[end] === delim[0]) end++;
      return end;
    }
    i++;
  }
  return -1;
}

/** Where a single-line string that starts at `from` (on its quote) ends, or the line end. */
function closeString(line: string, from: number): number {
  const quote = line[from];
  let i = from + 1;
  while (i < line.length) {
    if (quote === '"' && line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line[i] === quote) return i + 1;
    i++;
  }
  return line.length;
}

function tomlTokens(line: string, state: TomlState): Token[] {
  const tokens: Token[] = [];
  const push = (text: string, kind: Kind) => tokens.push({ text, kind });
  let i = 0;
  if (state.multiline) {
    const end = closeMultiline(line, 0, state.multiline);
    if (end < 0) {
      push(line, "string");
      return tokens;
    }
    push(line.slice(0, end), "string");
    state.multiline = undefined;
    i = end;
  } else if (!state.stack.length) {
    const h = HEADER.exec(line);
    if (h) {
      push(h[1]!, "plain");
      push(h[2]!, "header");
      i = h[0].length;
    }
  }
  // A key can start the line (outside arrays) and follow `{` or `,` inside an inline table.
  let expectKey = i === 0 && !state.stack.length && !tokens.length;
  while (i < line.length) {
    const rest = line.slice(i);
    const ch = line[i]!;
    if (ch === " " || ch === "\t") {
      const ws = /^[ \t]+/.exec(rest)![0];
      push(ws, "plain");
      i += ws.length;
      continue;
    }
    if (expectKey) {
      expectKey = false;
      const k = KEY.exec(rest);
      if (k) {
        push(k[0], "key");
        i += k[0].length;
        continue;
      }
    }
    if (ch === "#") {
      push(rest, "comment");
      break;
    }
    if (rest.startsWith('"""') || rest.startsWith("'''")) {
      const delim = rest.slice(0, 3) as '"""' | "'''";
      const end = closeMultiline(line, i + 3, delim);
      if (end < 0) {
        push(rest, "string");
        state.multiline = delim;
        break;
      }
      push(line.slice(i, end), "string");
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = closeString(line, i);
      push(line.slice(i, end), "string");
      i = end;
      continue;
    }
    if (ch === "[" || ch === "{") {
      state.stack.push(ch);
      push(ch, "plain");
      expectKey = ch === "{";
      i++;
      continue;
    }
    if (ch === "]" || ch === "}") {
      if (state.stack.at(-1) === (ch === "]" ? "[" : "{")) state.stack.pop();
      push(ch, "plain");
      i++;
      continue;
    }
    if (ch === ",") {
      expectKey = state.stack.at(-1) === "{";
      push(ch, "plain");
      i++;
      continue;
    }
    const w = WORD.exec(rest);
    if (w) {
      push(w[0], /^(?:true|false|[+-]?(?:inf|nan)|[+-]?[0-9][A-Za-z0-9_+\-.:]*)$/.test(w[0]) ? "literal" : "plain");
      i += w[0].length;
      continue;
    }
    push(ch, "plain");
    i++;
  }
  return markSecrets(tokens);
}

/** On a line marked `# secret, hidden`, the masked value (and the mark) stand out. */
function markSecrets(tokens: Token[]): Token[] {
  const last = tokens.at(-1);
  if (last?.kind !== "comment" || !SECRET_MARK.test(last.text)) return tokens;
  const strings = tokens.filter((t) => t.kind === "string");
  const masked = strings.filter((t) => t.text.includes("****"));
  for (const t of masked.length ? masked : strings) t.kind = "secret";
  last.kind = "secret";
  return tokens;
}

/** One TOML line, colored; `state` carries open arrays and strings to the next line. */
export function highlightTomlLine(line: string, state: TomlState): string {
  return render(tomlTokens(line, state));
}

/** A TOML text, colored line by line. */
export function highlightToml(text: string): string {
  const state = tomlState();
  return text
    .split("\n")
    .map((l) => highlightTomlLine(l, state))
    .join("\n");
}

// JSON ----------------------------------------------------------------------------------------

const JSON_LITERAL = /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/;

/** A JSON text, colored: keys, strings, and numbers with true, false and null. */
export function highlightJson(text: string): string {
  const tokens: Token[] = [];
  let i = 0;
  let plain = "";
  const flush = () => {
    if (plain) tokens.push({ text: plain, kind: "plain" });
    plain = "";
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"' && text[end] !== "\n") end += text[end] === "\\" ? 2 : 1;
      if (text[end] === '"') end++;
      const after = /^\s*/.exec(text.slice(end))![0];
      flush();
      tokens.push({ text: text.slice(i, end), kind: text[end + after.length] === ":" ? "key" : "string" });
      i = end;
      continue;
    }
    const prev = text[i - 1];
    const lit = prev === undefined || !/[A-Za-z0-9_.]/.test(prev) ? JSON_LITERAL.exec(text.slice(i)) : null;
    if (lit) {
      flush();
      tokens.push({ text: lit[0], kind: "literal" });
      i += lit[0].length;
      continue;
    }
    plain += ch;
    i++;
  }
  flush();
  return render(tokens);
}

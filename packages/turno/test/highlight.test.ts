import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { printJson } from "../src/cli/args.js";
import { highlightJson, highlightToml } from "../src/cli/highlight.js";
import { type Io, colors, paint } from "../src/cli/io.js";
import { main } from "../src/cli/main.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: it strips ANSI color codes, which start with ESC.
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const c = (code: string, text: string) => `\x1b[${code}m${text}\x1b[0m`;
const KEY = (t: string) => c("36", t);
const STR = (t: string) => c("32", t);
const LIT = (t: string) => c("35", t);
const DIM = (t: string) => c("2", t);
const BOLD = (t: string) => c("1", t);
const SECRET = (t: string) => c("33", t);

const TOML = [
  "# turno MCP manifest.",
  "",
  "[server.github]",
  'command = "gh-mcp" # the binary',
  'args = ["stdio", "--flag=#x", "say \\"hi\\" = ok", \'C:\\path\']',
  "idle = 300",
  "enabled = true",
  "ratio = -1.5e3",
  "when = 1979-05-27T07:32:00Z",
  "",
  "[server.github.env]",
  'GITHUB_TOKEN = "ghp_****1234"  # secret, hidden',
  "",
  "[[projects]]  # a list",
  'path = "~/code/a#b"',
  "profiles = [",
  '  "work",',
  '  ["nested"],',
  "  # comment inside",
  "  'personal', # trailing",
  "]",
  'inline = { a = 1, "b.c" = "x = y", d.e = false }',
  'multi = """first',
  'still "inside" # not a comment',
  'end"""  # after',
  "  'quoted key' = 2",
].join("\n");

describe("highlightToml", () => {
  const lines = highlightToml(TOML).split("\n");

  it("gives back the input exactly once the colors are stripped", () => {
    expect(strip(highlightToml(TOML))).toBe(TOML);
    expect(lines).toHaveLength(TOML.split("\n").length);
  });

  it("colors headers, keys, strings, literals and comments", () => {
    expect(lines[0]).toBe(DIM("# turno MCP manifest."));
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe(BOLD("[server.github]"));
    expect(lines[3]).toBe(`${KEY("command")} = ${STR('"gh-mcp"')} ${DIM("# the binary")}`);
    expect(lines[5]).toBe(`${KEY("idle")} = ${LIT("300")}`);
    expect(lines[6]).toBe(`${KEY("enabled")} = ${LIT("true")}`);
    expect(lines[7]).toBe(`${KEY("ratio")} = ${LIT("-1.5e3")}`);
    expect(lines[8]).toBe(`${KEY("when")} = ${LIT("1979-05-27T07:32:00Z")}`);
    expect(lines[13]).toBe(`${BOLD("[[projects]]")}  ${DIM("# a list")}`);
  });

  it("keeps #, = and escaped quotes inside strings", () => {
    expect(lines[4]).toBe(`${KEY("args")} = [${STR('"stdio"')}, ${STR('"--flag=#x"')}, ${STR('"say \\"hi\\" = ok"')}, ${STR("'C:\\path'")}]`);
    expect(lines[14]).toBe(`${KEY("path")} = ${STR('"~/code/a#b"')}`);
  });

  it("shows a masked secret in yellow", () => {
    expect(lines[11]).toBe(`${KEY("GITHUB_TOKEN")} = ${SECRET('"ghp_****1234"')}  ${SECRET("# secret, hidden")}`);
  });

  it("follows multi-line arrays: no keys or headers inside them", () => {
    expect(lines[15]).toBe(`${KEY("profiles")} = [`);
    expect(lines[16]).toBe(`  ${STR('"work"')},`);
    expect(lines[17]).toBe(`  [${STR('"nested"')}],`);
    expect(lines[18]).toBe(`  ${DIM("# comment inside")}`);
    expect(lines[19]).toBe(`  ${STR("'personal'")}, ${DIM("# trailing")}`);
    expect(lines[20]).toBe("]");
  });

  it("colors keys of inline tables and quoted keys", () => {
    expect(lines[21]).toBe(`${KEY("inline")} = { ${KEY("a")} = ${LIT("1")}, ${KEY('"b.c"')} = ${STR('"x = y"')}, ${KEY("d.e")} = ${LIT("false")} }`);
    expect(lines[25]).toBe(`  ${KEY("'quoted key'")} = ${LIT("2")}`);
  });

  it("keeps a multi-line string whole", () => {
    expect(lines[22]).toBe(`${KEY("multi")} = ${STR('"""first')}`);
    expect(lines[23]).toBe(STR('still "inside" # not a comment'));
    expect(lines[24]).toBe(`${STR('end"""')}  ${DIM("# after")}`);
  });

  it("never throws on broken input and still round-trips", () => {
    for (const bad of ['a = "unclosed', "]]]", "[[", "= = =", 'x = """', "{ a = [ 1, }", "\\", "'''\n'''x", "[a.\"b]"]) {
      expect(strip(highlightToml(bad))).toBe(bad);
    }
  });
});

describe("highlightJson", () => {
  const value = {
    name: 'a "quoted" \\ value: {x}',
    n: -12.5e3,
    ok: true,
    none: null,
    list: [1, "two", false, { "k:ey": "v,al" }],
    empty: {},
    url: "http://127.0.0.1:8080/mcp?x=1#frag",
  };
  const text = JSON.stringify(value, null, 2);
  const lines = highlightJson(text).split("\n");

  it("gives back the input exactly once the colors are stripped", () => {
    expect(strip(highlightJson(text))).toBe(text);
    expect(strip(highlightJson(JSON.stringify(value)))).toBe(JSON.stringify(value));
    expect(lines).toHaveLength(text.split("\n").length);
  });

  it("colors keys, strings and literals, and leaves punctuation plain", () => {
    expect(lines[0]).toBe("{");
    expect(lines[1]).toBe(`  ${KEY('"name"')}: ${STR('"a \\"quoted\\" \\\\ value: {x}"')},`);
    expect(lines[2]).toBe(`  ${KEY('"n"')}: ${LIT("-12500")},`);
    expect(lines[3]).toBe(`  ${KEY('"ok"')}: ${LIT("true")},`);
    expect(lines[4]).toBe(`  ${KEY('"none"')}: ${LIT("null")},`);
    expect(lines[6]).toBe(`    ${LIT("1")},`);
    expect(lines[7]).toBe(`    ${STR('"two"')},`);
    expect(lines[10]).toBe(`      ${KEY('"k:ey"')}: ${STR('"v,al"')}`);
  });

  it("colors a bare value", () => {
    expect(highlightJson('"x"')).toBe(STR('"x"'));
    expect(highlightJson("42")).toBe(LIT("42"));
  });
});

describe("colors", () => {
  const io = (env: NodeJS.ProcessEnv, isTty: boolean): Io => ({ ...fakeIo(env), isTty });

  it("colors a terminal unless NO_COLOR is set; FORCE_COLOR colors a pipe too", () => {
    expect(colors(io({}, true))).toBe(true);
    expect(colors(io({}, false))).toBe(false);
    expect(colors(io({ NO_COLOR: "1" }, true))).toBe(false);
    expect(colors(io({ FORCE_COLOR: "1" }, false))).toBe(true);
    expect(colors(io({ FORCE_COLOR: "0" }, true))).toBe(false);
    expect(colors(io({ FORCE_COLOR: "false" }, true))).toBe(false);
    expect(colors(io({ FORCE_COLOR: "1", NO_COLOR: "1" }, false))).toBe(false);
    expect(paint(io({ FORCE_COLOR: "1" }, false), "x", "1")).toBe(BOLD("x"));
  });

  it("never colors --json in a pipe, even with FORCE_COLOR, since programs read it", () => {
    const lines = (env: NodeJS.ProcessEnv, isTty: boolean) => {
      const o = io(env, isTty);
      const got: string[] = [];
      printJson({ ...o, out: (l?: string) => got.push(l ?? "") }, { a: 1 });
      return got.join("\n");
    };
    expect(lines({ FORCE_COLOR: "1" }, false)).toBe('{\n  "a": 1\n}');
    expect(lines({}, true)).toContain("\x1b[");
  });
});

describe("colored output in a terminal", () => {
  let sb: Sandbox;
  const home = (rel: string) => join(sb.home, rel);
  const GHP = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

  beforeEach(() => {
    sb = sandbox();
    sb.env.PATH = `${home(".local/bin")}:/usr/bin:/bin`;
    sb.env.SHELL = "/bin/zsh";
    fakeCommand(sb, "claude", `echo '{"loggedIn":false}'`);
    fakeCommand(sb, "npm", "echo null");
    mkdirSync(home(".claude"), { recursive: true });
    writeFileSync(home(".claude/settings.json"), "{}\n");
    sb.write(".claude.json", JSON.stringify({ mcpServers: { github: { command: "github-mcp-server", args: ["stdio"], env: { GITHUB_TOKEN: GHP } } } }));
  });
  afterEach(() => sb.cleanup());

  /** Run a command three ways: piped, in a terminal with NO_COLOR, and in a terminal. */
  async function threeWays(args: string[]) {
    const once = async (env: NodeJS.ProcessEnv, isTty: boolean) => {
      const io = { ...fakeIo(env), isTty };
      const code = await main(args, io);
      return { code, out: io.lines.join("\n"), err: io.errors.join("\n") };
    };
    return { piped: await once(sb.env, false), noColor: await once({ ...sb.env, NO_COLOR: "1" }, true), tty: await once(sb.env, true) };
  }

  /**
   * The words a screen says, whatever the terminal: no colors, no section rules, no status
   * icons (Unicode on a terminal, ASCII in a pipe) and no padding around profile pills.
   */
  const words = (text: string) =>
    strip(text)
      .split("\n")
      .map((l) => l.replace(/ ─+$/, "").replace(/^\s*(✓|✗|•|–|!|ok|x|-|●|○|➜|→)\s+/, "").replace(/\s+/g, " ").trim())
      .join("\n");

  for (const args of [["init", "--dry-run"], ["mcp", "import"], ["config", "path", "--json"]]) {
    it(`turno ${args.join(" ")}: colors only a terminal, and the text is the same`, async () => {
      const { piped, noColor, tty } = await threeWays(args);
      expect(piped.code).toBe(0);
      expect(piped.out).not.toContain("\x1b[");
      expect(noColor).toEqual(piped);
      expect(tty.code).toBe(0);
      expect(tty.out).toContain("\x1b[");
      expect(words(tty.out)).toBe(words(piped.out));
      expect(words(tty.err)).toBe(words(piped.err));
      expect(tty.out).not.toContain(GHP);
    });
  }

  it("turno init: diff markers keep their color and the content is highlighted", async () => {
    const { tty } = await threeWays(["init", "--dry-run"]);
    expect(tty.out).toContain(`${c("32", "+")}${BOLD("[server.github]")}`);
    expect(tty.out).toContain(`${c("32", "+")}${KEY("GITHUB_TOKEN")} = ${SECRET('"ghp_****6789"')}  ${SECRET("# secret, hidden")}`);
  });

  it("turno init: the config.toml diff highlights context lines inside a multi-line array", async () => {
    sb.write(".config/turno/config.toml", '# my config\nnerd_terminals = [\n  "warp",  # mine\n]\n');
    const { piped, noColor, tty } = await threeWays(["init", "--dry-run", "--no-mcp", "--profile", "work"]);
    expect(piped.out).toContain('       "warp",  # mine\n     ]\n    +\n    +[profiles.work]');
    expect(noColor).toEqual(piped);
    expect(words(tty.out)).toBe(words(piped.out));
    expect(tty.out).toContain(`       ${STR('"warp"')},  ${DIM("# mine")}\n     ]\n    ${c("32", "+")}\n    ${c("32", "+")}${BOLD("[profiles.work]")}`);
  });

  it("turno mcp config: the JSON snippet is highlighted, the header lines are dim", async () => {
    sb.write(".config/turno/mcp.toml", '[server.calc]\ncommand = "calc-mcp"\nscope = "shared"\n');
    const { piped, noColor, tty } = await threeWays(["mcp", "config", "--agent", "kiro", "--profile", "default"]);
    expect(piped.code).toBe(0);
    expect(piped.out).not.toContain("\x1b[");
    expect(noColor).toEqual(piped);
    expect(strip(tty.out)).toBe(piped.out);
    expect(tty.out).toContain(DIM("# ~/.kiro/settings/mcp.json"));
    expect(tty.out).toContain(`${KEY('"mcpServers"')}: {`);
  });

  it("turno config path --json: keys and values are colored", async () => {
    const { tty } = await threeWays(["config", "path", "--json"]);
    expect(tty.out).toContain(`${KEY('"exists"')}: ${LIT("false")}`);
  });
});

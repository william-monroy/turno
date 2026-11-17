import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { command as open } from "../src/cli/commands/open.js";
import { main } from "../src/cli/main.js";
import {
  type PickItem,
  type Terminal,
  initialState,
  matching,
  parseKeys,
  realTerminal,
  reduce,
  renderPicker,
  runPicker,
  selected,
} from "../src/cli/picker.js";
import { stripAnsi, style } from "../src/cli/style.js";
import { loadConfig } from "../src/core/config.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

const item = (value: string, search = ""): PickItem => ({ value, cells: [value, "Claude Code", search], search });
const ITEMS = [item("work", "alice@example.com"), item("personal", "bob@example.com"), item("lab", "not logged in")];

describe("picker keys", () => {
  it("reads arrows, j/k, Enter, Esc, Ctrl-C, backspace and letters from raw input", () => {
    expect(parseKeys("\x1b[A\x1b[B\x1bOA")).toEqual([{ name: "up" }, { name: "down" }, { name: "up" }]);
    expect(parseKeys("\r")).toEqual([{ name: "enter" }]);
    expect(parseKeys("\x1b")).toEqual([{ name: "cancel" }]);
    expect(parseKeys("\x03")).toEqual([{ name: "cancel" }]);
    expect(parseKeys("ab\x7f")).toEqual([{ name: "char", ch: "a" }, { name: "char", ch: "b" }, { name: "backspace" }]);
    expect(parseKeys("\x1b[5~\x1b[6~\x1b[H\x1b[F")).toEqual([{ name: "pageUp" }, { name: "pageDown" }, { name: "home" }, { name: "end" }]);
    // Sequences the picker does not use (F5, a mouse report) are skipped whole.
    expect(parseKeys("\x1b[15~x")).toEqual([{ name: "char", ch: "x" }]);
    expect(parseKeys("\x15\x0e\x10")).toEqual([{ name: "clear" }, { name: "down" }, { name: "up" }]);
  });

  it("moves with arrows and j/k, wrapping at the ends", () => {
    let s = initialState(ITEMS, "work");
    s = reduce(s, { name: "char", ch: "j" }).state;
    expect(selected(s)?.value).toBe("personal");
    s = reduce(s, { name: "down" }).state;
    s = reduce(s, { name: "down" }).state;
    expect(selected(s)?.value).toBe("work");
    s = reduce(s, { name: "char", ch: "k" }).state;
    expect(selected(s)?.value).toBe("lab");
    expect(s.query).toBe("");
  });

  it("filters by typing (names first, then accounts), and j/k are letters once typing starts", () => {
    let s = initialState(ITEMS, "work");
    for (const ch of "la") s = reduce(s, { name: "char", ch }).state;
    expect(matching(s).map((i) => i.value)).toEqual(["lab"]);
    s = reduce(s, { name: "clear" }).state;
    for (const ch of "bob") s = reduce(s, { name: "char", ch }).state;
    expect(matching(s).map((i) => i.value)).toEqual(["personal"]);
    s = reduce(initialState(ITEMS), { name: "char", ch: "o" }).state;
    s = reduce(s, { name: "char", ch: "j" }).state;
    expect(s.query).toBe("oj");
    s = reduce(s, { name: "backspace" }).state;
    expect(s.query).toBe("o");
    // "o" is in work and personal by name, and in lab's account.
    expect(matching(s).map((i) => i.value)).toEqual(["work", "personal", "lab"]);
  });

  it("chooses with Enter, does nothing when nothing matches, and cancels", () => {
    const s = initialState(ITEMS, "personal");
    expect(reduce(s, { name: "enter" }).outcome).toEqual({ kind: "pick", value: "personal" });
    let none = s;
    for (const ch of "zz") none = reduce(none, { name: "char", ch }).state;
    expect(reduce(none, { name: "enter" }).outcome).toBeUndefined();
    expect(reduce(s, { name: "cancel" }).outcome).toEqual({ kind: "cancel" });
  });

  it("keeps the cursor on the same profile while the filter still matches it", () => {
    let s = initialState(ITEMS, "personal");
    s = reduce(s, { name: "char", ch: "r" }).state;
    expect(selected(s)?.value).toBe("personal");
  });

  it("draws the rows with a pointer, the filter and the keys; plain glyphs without colors", () => {
    const s = style({ env: { NO_COLOR: "1", COLUMNS: "100" }, isTty: true });
    const lines = renderPicker(initialState(ITEMS, "personal"), s, { title: "Profile for ~/code", maxRows: 10 });
    expect(lines[0]).toBe("? Profile for ~/code");
    expect(lines[2]).toMatch(/^ > personal\s+Claude Code\s+bob@example.com$/);
    expect(lines.at(-1)).toContain("up/down or j/k move, type to filter, enter choose, esc cancel");
    const filtered = renderPicker(reduce(initialState(ITEMS), { name: "char", ch: "q" }).state, s, { title: "Pick", maxRows: 10 });
    expect(filtered[0]).toBe("? Pick  filter q_");
    expect(filtered[1]).toBe('  no profile matches "q"');
    const scrolled = renderPicker(initialState(ITEMS), s, { title: "Pick", maxRows: 2 });
    expect(scrolled).toContain("  1 more");
  });
});

/** A terminal that types `keys` once the picker starts, and records what is drawn. */
function fakeTerminal(keys: string[]): Terminal & { out: string; starts: number; stops: number } {
  const t = {
    out: "",
    starts: 0,
    stops: 0,
    columns: () => 100,
    rows: () => 30,
    write(text: string) {
      t.out += text;
    },
    start(onData: (chunk: string) => void) {
      t.starts++;
      void (async () => {
        for (const k of keys) {
          await new Promise((r) => setTimeout(r, 0));
          onData(k);
        }
      })();
      return () => {
        t.stops++;
      };
    },
  };
  return t;
}

describe("runPicker", () => {
  const s = style({ env: { NO_COLOR: "1" }, isTty: true });

  it("returns the choice, erases itself and leaves one line", async () => {
    const term = fakeTerminal(["\x1b[B", "\r"]);
    const v = await runPicker(term, s, ITEMS, { title: "Pick", maxRows: 10, initial: "work", chosen: (x) => `chose ${x}` });
    expect(v).toBe("personal");
    expect(term.stops).toBe(1);
    expect(term.out.startsWith("\x1b[?25l")).toBe(true);
    expect(term.out).toContain("\x1b[J");
    expect(term.out.endsWith("chose personal\n\x1b[?25h")).toBe(true);
  });

  it("restores the terminal on cancel", async () => {
    const term = fakeTerminal(["\x1b"]);
    expect(await runPicker(term, s, ITEMS, { title: "Pick", maxRows: 10 })).toBeUndefined();
    expect(term.stops).toBe(1);
    expect(term.out.endsWith("\x1b[?25h")).toBe(true);
    expect(term.out).not.toContain("chose");
  });

  it("restores the terminal when drawing fails", async () => {
    const term = fakeTerminal(["\x1b[B"]);
    let n = 0;
    const write = term.write.bind(term);
    term.write = (text: string) => {
      if (++n === 4) throw new Error("terminal gone");
      write(text);
    };
    await expect(runPicker(term, s, ITEMS, { title: "Pick", maxRows: 10 })).rejects.toThrow("terminal gone");
    expect(term.stops).toBe(1);
    expect(term.out.endsWith("\x1b[?25h")).toBe(true);
  });

  it("redraws with the accounts when they arrive, keeping the cursor", async () => {
    let ready: (items: PickItem[]) => void = () => {};
    const update = new Promise<PickItem[]>((r) => {
      ready = r;
    });
    const term = fakeTerminal([]);
    const keys: ((c: string) => void)[] = [];
    term.start = (onData) => {
      keys.push(onData);
      return () => {
        term.stops++;
      };
    };
    const done = runPicker(term, s, [item("work"), item("lab")], { title: "Pick", maxRows: 10, initial: "lab", update });
    ready([item("work", "alice@example.com"), item("lab", "carol@example.com")]);
    await new Promise((r) => setTimeout(r, 0));
    expect(term.out).toContain("carol@example.com");
    keys[0]!("\r");
    expect(await done).toBe("lab");
  });
});

describe("picker resize", () => {
  it("redraws to the new width when the terminal is resized", async () => {
    const wide = [item("work", "alice.longer.name@example.com")];
    let cols = 100;
    let onKey: (c: string) => void = () => {};
    let onResize: (() => void) | undefined;
    let out = "";
    const term: Terminal = {
      columns: () => cols,
      rows: () => 30,
      write: (t) => {
        out += t;
      },
      start(data, resize) {
        onKey = data;
        onResize = resize;
        return () => {};
      },
    };
    const styleAt = (c: number) => style({ env: { COLUMNS: String(c) }, isTty: true });
    const done = runPicker(term, styleAt(100), wide, { title: "Pick", maxRows: 10, styleAt });
    expect(stripAnsi(out)).toContain("Claude Code");
    cols = 40;
    out = "";
    onResize!();
    // At 40 columns the agent column goes first.
    expect(stripAnsi(out)).not.toContain("Claude Code");
    expect(stripAnsi(out)).toContain("alice.longer.name@example.com");
    onKey("\r");
    expect(await done).toBe("work");
  });
});

describe("realTerminal", () => {
  function fakes() {
    const input = Object.assign(new EventEmitter(), {
      isRaw: false,
      setRawMode: vi.fn(function (this: { isRaw: boolean }, m: boolean) {
        input.isRaw = m;
      }),
      setEncoding: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
    });
    const written: string[] = [];
    const output = Object.assign(new EventEmitter(), { columns: 90, rows: 20, write: (t: string) => written.push(t) });
    const proc = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() });
    return { input, output, proc, written };
  }

  it("turns raw mode on, and back off with the cursor shown when stopped", () => {
    const f = fakes();
    const term = realTerminal(f.input, f.output, f.proc as never);
    const stop = term.start(() => {});
    expect(f.input.isRaw).toBe(true);
    expect(f.proc.listenerCount("SIGTERM")).toBe(1);
    stop();
    stop();
    expect(f.input.isRaw).toBe(false);
    expect(f.input.listenerCount("data")).toBe(0);
    expect(f.proc.listenerCount("SIGTERM")).toBe(0);
    expect(f.written).toEqual(["\x1b[?25h"]);
  });

  it("restores the terminal before a signal ends the process", () => {
    const f = fakes();
    realTerminal(f.input, f.output, f.proc as never).start(() => {});
    f.proc.emit("SIGTERM", "SIGTERM");
    expect(f.input.isRaw).toBe(false);
    expect(f.written).toEqual(["\x1b[?25h"]);
    expect(f.proc.kill).toHaveBeenCalledWith(4242, "SIGTERM");
  });
});

describe("commands without a profile", () => {
  let sb: Sandbox;
  const cfg = () => join(sb.home, ".config/turno/config.toml");
  beforeEach(() => {
    sb = sandbox();
    fakeCommand(sb, "claude", `echo '{"loggedIn":true,"email":"someone@example.com"}'`);
    for (const p of ["personal", "work"]) {
      mkdirSync(join(sb.home, `.claude-${p}`), { recursive: true });
      sb.write(`.local/bin/claude-${p}`, "#!/bin/sh\n# Generated by turno\necho launched $0\n", 0o755);
    }
    sb.write(".config/turno/config.toml", 'system = "personal"\n');
    mkdirSync(join(sb.home, "code"), { recursive: true });
  });
  afterEach(() => sb.cleanup());

  it("exit 2 and list the valid values where nobody can answer", async () => {
    const before = readFileSync(cfg(), "utf8");
    const cases: [string[], string][] = [
      [["profile", "assign", join(sb.home, "code")], "turno: profile assign needs an answer; pass a profile: personal, work"],
      [["profile", "remove"], "turno: profile remove needs an answer; pass a profile: personal, work"],
      [["run"], "turno: run needs an answer; pass a profile: personal, work, auto"],
      [["limit", "set"], "turno: limit set needs an answer; pass a profile: personal, work"],
      [["limit", "clear"], "turno: limit clear needs an answer; pass a profile: personal, work"],
      [["session", "handoff"], "turno: session handoff needs an answer; pass a profile: personal, work, auto"],
    ];
    for (const [args, message] of cases) {
      const io = fakeIo(sb.env);
      expect(await main(args, io), args.join(" ")).toBe(2);
      expect(io.errors[0], args.join(" ")).toContain(message);
    }
    // --no-input with a person on the terminal: the same, without asking.
    const asked = vi.fn(async () => "1");
    const io = { ...fakeIo(sb.env), ask: asked };
    expect(await main(["--no-input", "profile", "assign", join(sb.home, "code")], io)).toBe(2);
    expect(asked).not.toHaveBeenCalled();
    expect(readFileSync(cfg(), "utf8")).toBe(before);
  });

  it("run lists auto first, named with the profile this folder resolves to", async () => {
    // No rule and no default: auto resolves to nothing, so it is not offered.
    const none = fakeTerminal(["\x1b"]);
    const plain = { ...fakeIo(sb.env), ask: async () => "", terminal: none };
    expect(await main(["run"], plain)).toBe(130);
    expect(stripAnsi(none.out)).not.toContain("auto");

    sb.write(".config/turno/config.toml", 'system = "personal"\ndefault = "work"\n');
    const term = fakeTerminal(["\x1b"]);
    const io = { ...fakeIo(sb.env), ask: async () => "", terminal: term };
    expect(await main(["run"], io)).toBe(130);
    const rows = stripAnsi(term.out.slice(term.out.lastIndexOf("Profile to open")))
      .split("\n")
      .filter((l) => /auto|personal|work/.test(l));
    expect(rows[0]).toMatch(/^ ❯ auto \(work\)\s+Claude Code\s+folder without a rule/);
    expect(rows[1]).toMatch(/^ {4}personal\s/);
    expect(rows[2]).toMatch(/^ {4}work\s/);

    // Without a raw terminal the numbered list starts with it too, and the message for
    // nobody to answer still names it.
    const stdin = process.stdin as { isTTY?: boolean };
    const was = stdin.isTTY;
    stdin.isTTY = false;
    try {
      const asked = { ...fakeIo(sb.env), ask: vi.fn(async () => "nobody") };
      expect(await main(["run"], asked)).toBe(2);
      expect(asked.ask).toHaveBeenCalledWith("Number or name [1]: ");
      expect(stripAnsi(asked.errors.join("\n"))).toMatch(/1\s+auto \(work\)\s+Claude Code/);
      expect(asked.errors.at(-1)).toBe("turno: no profile 'nobody'; pass a profile: auto, personal, work");
    } finally {
      stdin.isTTY = was;
    }
    const nobody = fakeIo(sb.env);
    expect(await main(["run"], nobody)).toBe(2);
    expect(nobody.errors[0]).toContain("pass a profile: personal, work, auto");
  });

  it("session handoff still prints the profiles and the current one for scripts", async () => {
    const io = fakeIo({ ...sb.env, CLAUDE_CONFIG_DIR: join(sb.home, ".claude-work") });
    expect(await main(["session", "handoff"], io)).toBe(2);
    expect(io.lines).toEqual(["profiles: personal work auto", "current: work"]);
  });

  it("says how to create a profile when there is none", async () => {
    sb.cleanup();
    sb = sandbox();
    const io = fakeIo(sb.env);
    expect(await main(["run"], io)).toBe(2);
    expect(io.errors[0]).toBe("turno: no profiles yet; create one with turno profile add <name>");
  });

  it("profile assign uses the profile chosen in the picker, and a cancel changes nothing (exit 130)", async () => {
    const dir = join(sb.home, "code");
    const before = readFileSync(cfg(), "utf8");
    const cancel = { ...fakeIo(sb.env), ask: async () => "", terminal: fakeTerminal(["\x1b"]) };
    expect(await main(["profile", "assign", dir], cancel)).toBe(130);
    expect(cancel.errors).toEqual(["turno: cancelled; nothing changed"]);
    expect(readFileSync(cfg(), "utf8")).toBe(before);

    const term = fakeTerminal(["w", "\r"]);
    const io = { ...fakeIo(sb.env), ask: async () => "", terminal: term };
    expect(await main(["profile", "assign", dir], io)).toBe(0);
    expect(io.lines[0]).toBe("~/code -> work");
    expect(loadConfig(sb.env).projects.map((r) => r.profile)).toEqual(["work"]);
    expect(term.stops).toBe(1);
  });

  it("asks by number when a person can answer but stdin is not a raw terminal", async () => {
    const stdin = process.stdin as { isTTY?: boolean };
    const was = stdin.isTTY;
    stdin.isTTY = false;
    try {
      const io = { ...fakeIo(sb.env), ask: vi.fn(async () => "2") };
      expect(await main(["profile", "assign", join(sb.home, "code")], io)).toBe(0);
      expect(io.ask).toHaveBeenCalledWith("Number or name: ");
      expect(stripAnsi(io.errors.join("\n"))).toMatch(/1\s+personal\s+Claude Code\s+someone@example.com/);
      expect(loadConfig(sb.env).projects[0]?.profile).toBe("work");
    } finally {
      stdin.isTTY = was;
    }
  });

  it("profile remove confirms a picked profile, and a no keeps it", async () => {
    const stdin = process.stdin as { isTTY?: boolean };
    const was = stdin.isTTY;
    stdin.isTTY = false;
    try {
      const answers = ["work", "n"];
      const no = { ...fakeIo(sb.env), ask: async () => answers.shift()! };
      expect(await main(["profile", "remove"], no)).toBe(1);
      expect(no.errors.at(-1)).toBe("Nothing changed.");
      expect(readFileSync(join(sb.home, ".local/bin/claude-work"), "utf8")).toContain("Generated by turno");
      const yes = ["work", "y"];
      const io = { ...fakeIo(sb.env), ask: async () => yes.shift()! };
      expect(await main(["profile", "remove"], io)).toBe(0);
      expect(io.lines[0]).toMatch(/^- \[profiles.work\]/);
    } finally {
      stdin.isTTY = was;
    }
  });

  it("limit set marks the chosen profile", async () => {
    const io = { ...fakeIo(sb.env), ask: async () => "", terminal: fakeTerminal(["\x1b[B", "\r"]) };
    expect(await main(["limit", "set", "--for", "1h"], io)).toBe(0);
    expect(io.lines[0]).toMatch(/^work exhausted until/);
  });

  it("open asks only for a claude.ai link outside a profile's session", async () => {
    const log = join(sb.home, "open.log");
    for (const name of ["open", "xdg-open"]) fakeCommand(sb, name, `printf '%s\\n' "$@" > "${log}"`);
    mkdirSync(join(sb.home, "Chrome.app"));
    const env = { ...sb.env, TURNO_CHROME_APP: join(sb.home, "Chrome.app") };
    const term = fakeTerminal(["k", "\r"]);
    const io = { ...fakeIo(env), ask: async () => "", terminal: term };
    expect(await open.run(["https://claude.ai/chat/1"], io)).toBe(0);
    if (process.platform === "darwin") expect(readFileSync(log, "utf8")).toContain("--profile-directory=work");
    // Inside a profile's session, and for other links, the default stays and nothing is asked.
    const quiet = fakeTerminal(["\x1b"]);
    const inside = { ...fakeIo({ ...env, CLAUDE_CONFIG_DIR: join(sb.home, ".claude-work") }), ask: async () => "", terminal: quiet };
    expect(await open.run(["https://claude.ai/chat/2"], inside)).toBe(0);
    const other = { ...fakeIo(env), ask: async () => "", terminal: quiet };
    expect(await open.run(["https://example.com/x"], other)).toBe(0);
    expect(quiet.starts).toBe(0);
  });
});

describe("profile and session lists", () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = sandbox();
    fakeCommand(sb, "claude", `echo '{"loggedIn":true,"email":"someone@example.com","subscriptionType":"max"}'`);
    for (const p of ["personal", "work"]) {
      mkdirSync(join(sb.home, `.claude-${p}`), { recursive: true });
      sb.write(`.local/bin/claude-${p}`, "#!/bin/sh\n# Generated by turno\n", 0o755);
    }
    sb.write(".config/turno/config.toml", `default = "work"\n[profiles.work]\ncolor = "violet"\n[[projects]]\npath = "~/code"\nprofile = "work"\n`);
  });
  afterEach(() => sb.cleanup());

  it("profile list: one plain row per profile, starting with its name", async () => {
    const io = fakeIo(sb.env);
    expect(await main(["profile", "list"], io)).toBe(0);
    expect(io.lines).toHaveLength(2);
    expect(io.lines[0]).toMatch(/^personal\s+Claude Code\s+someone@example.com · max\s+no folders$/);
    expect(io.lines[1]).toMatch(/^work\s+Claude Code\s+someone@example.com · max\s+1 folder\s+default$/);
  });

  it("profile list on a terminal: a header, pills in the profile's color, and a hint", async () => {
    const io = { ...fakeIo({ ...sb.env, COLUMNS: "100" }), isTty: true };
    expect(await main(["profile", "list"], io)).toBe(0);
    expect(stripAnsi(io.lines[0]!)).toMatch(/^Profiles ─+$/);
    expect(stripAnsi(io.lines[1]!)).toMatch(/^ {2}\s+agent\s+account\s+folders\s+role$/);
    expect(io.lines[3]).toContain("\x1b[48;5;91;1;38;5;255m work \x1b[0m");
    expect(stripAnsi(io.lines.at(-1)!)).toContain("turno <name> opens one");
  });
});

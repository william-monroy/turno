import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { summarize } from "../src/cli/commands/undo.js";
import { writeLauncher } from "../src/cli/launchers.js";
import { main } from "../src/cli/main.js";
import { groupNotes } from "../src/cli/commands/init.js";
import { ICONS, duration, level, padEnd, profileColor, spinner, stripAnsi, style, termWidth, visibleWidth, wrapAnsi } from "../src/cli/style.js";
import { tildify } from "../src/core/paths.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

const tty = (env: NodeJS.ProcessEnv = {}) => ({ env, isTty: true });
const pipe = (env: NodeJS.ProcessEnv = {}) => ({ env, isTty: false });

describe("style: colors and icons", () => {
  it("uses Unicode icons on a terminal, Nerd icons when asked, ASCII without colors", () => {
    expect(style(tty()).icons).toBe("unicode");
    expect(style(tty(), { nerd: true }).icons).toBe("nerd");
    expect(style(pipe()).icons).toBe("ascii");
    expect(style(tty({ NO_COLOR: "1" }), { nerd: true }).icons).toBe("ascii");
    expect(style(pipe({ FORCE_COLOR: "1" })).icons).toBe("unicode");
    expect(stripAnsi(style(tty()).icon("ok"))).toBe("✓");
    expect(stripAnsi(style(tty(), { nerd: true }).icon("ok"))).toBe(ICONS.nerd.ok);
    expect([style(pipe()).icon("ok"), style(pipe()).icon("warn"), style(pipe()).icon("err")]).toEqual(["ok", "!", "x"]);
  });

  it("paints semantic colors only on a terminal", () => {
    const s = style(tty());
    expect(s.ok("a")).toBe("\x1b[32ma\x1b[0m");
    expect(s.warn("a")).toBe("\x1b[33ma\x1b[0m");
    expect(s.err("a")).toBe("\x1b[31ma\x1b[0m");
    expect(s.accent("a")).toBe("\x1b[36ma\x1b[0m");
    expect(style(pipe()).ok("a")).toBe("a");
  });

  it("aligns checklist rows whatever the icon set", () => {
    expect(style(pipe()).check("ok", "done")).toBe("ok done");
    expect(style(pipe()).check("warn", "careful")).toBe("!  careful");
    expect(stripAnsi(style(tty()).check("ok", "done"))).toBe("✓ done");
  });

  it("draws a profile as a pill in its own color, or the bare name in plain text", () => {
    expect(style(tty()).profile("work", 28)).toBe("\x1b[48;5;28;1;38;5;255m work \x1b[0m");
    expect(style(pipe()).profile("work", 28)).toBe("work");
    expect(profileColor({ work: { color: "red" } }, "work")).toBe(124);
    expect(profileColor({ work: { color: 99 } }, "work")).toBe(99);
    expect(profileColor({ a: {}, b: {} }, "b")).toBe(28);
  });

  it("puts a faint rule after section headers on a terminal only", () => {
    expect(style(pipe()).header("Profiles")).toBe("Profiles");
    const h = stripAnsi(style(tty({ COLUMNS: "60" })).header("Profiles"));
    expect(h).toMatch(/^Profiles ─+$/);
    expect(visibleWidth(h)).toBe(60);
  });
});

describe("style: widths, tables and bars", () => {
  it("reads the width from COLUMNS, then the terminal, with 80 for a pipe", () => {
    expect(termWidth(pipe())).toBe(80);
    expect(termWidth(pipe({ COLUMNS: "120" }))).toBe(120);
    expect(termWidth(pipe({ COLUMNS: "10" }))).toBe(40);
    expect(termWidth(pipe({ COLUMNS: "wide" }))).toBe(80);
  });

  it("measures and pads text without counting ANSI codes", () => {
    const s = style(tty());
    expect(visibleWidth(s.bold("abc"))).toBe(3);
    expect(visibleWidth(padEnd(s.ok("ab"), 5))).toBe(5);
  });

  it("aligns columns, right-aligns when asked, and drops columns on a narrow terminal only", () => {
    const rows = [
      ["a", "1", "first long note"],
      ["bbb", "22", "x"],
    ];
    expect(style(pipe()).table(rows, { columns: [{}, { align: "right" }, {}] })).toEqual(["  a     1  first long note", "  bbb  22  x"]);
    const narrow = style(tty({ COLUMNS: "40" }));
    const wide = [["name", "x".repeat(30), "y".repeat(10)]];
    expect(stripAnsi(narrow.table(wide, { columns: [{}, { drop: 1 }, {}] })[0]!)).toBe(`  name  ${"y".repeat(10)}`);
    expect(style(pipe({ COLUMNS: "40" })).table(wide, { columns: [{}, { drop: 1 }, {}] })[0]).toContain("x".repeat(30));
  });

  it("colors usage bars by level: below 60 green, below 85 yellow, then red", () => {
    expect([level(59), level(60), level(84), level(85), level(100)]).toEqual(["ok", "warn", "warn", "err", "err"]);
    const s = style(tty());
    expect(s.bar(42, 10)).toContain("\x1b[32m━━━━\x1b[0m");
    expect(s.bar(70, 10)).toContain("\x1b[33m━━━━━━━\x1b[0m");
    expect(s.bar(90, 10)).toContain("\x1b[31m━━━━━━━━━\x1b[0m");
    expect(style(pipe()).bar(42, 10)).toBe("████░░░░░░  42%");
    expect(style(pipe()).bar(150, 4)).toBe("████ 100%");
    expect(style(pipe()).bar(-5, 4)).toBe("░░░░   0%");
  });

  it("prints durations like a person reads them", () => {
    expect([duration(42), duration(1234), duration(65_000)]).toEqual(["42ms", "1.2s", "1m05s"]);
  });
});

describe("style: nothing runs past the terminal width", () => {
  it("wraps at spaces, keeps alignment spaces when it fits, and ignores ANSI codes", () => {
    expect(wrapAnsi("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
    expect(wrapAnsi("  a  b", 10)).toEqual(["  a  b"]);
    expect(wrapAnsi("\x1b[2maaa bbb\x1b[0m ccc", 7).map(stripAnsi)).toEqual(["aaa bbb", "ccc"]);
    expect(wrapAnsi("x".repeat(12), 5)).toEqual(["x".repeat(12)]);
  });

  it("hangs wrapped lines under where the text starts, on a terminal only", () => {
    const text = "one two three four five six seven eight nine ten eleven twelve";
    const lines = stripAnsi(style(tty({ COLUMNS: "40" })).note("warn", text)).split("\n");
    expect(lines[0]).toBe("  ! one two three four five six seven");
    for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(40);
    for (const l of lines.slice(1)) expect(l).toMatch(/^ {4}\S/);
    expect(style(pipe({ COLUMNS: "40" })).note("warn", text)).toBe(`  !  ${text}`);
  });

  it("wraps the last cell of a table under its own column", () => {
    const rows = [["~/.claude-work", "23 links removed, settings.json moved back, aside folder removed"]];
    const lines = style(tty({ COLUMNS: "50" })).table(rows).map(stripAnsi);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(50);
    for (const l of lines.slice(1)) expect(l).toMatch(/^ {18}\S/);
    expect(style(pipe({ COLUMNS: "50" })).table(rows)).toEqual([`  ${rows[0]![0]}  ${rows[0]![1]}`]);
  });
});

describe("init notes", () => {
  it("groups a note repeated across servers and keeps specific ones", () => {
    const unknown = 'scope project: unknown server, one process per project folder; set scope = "shared" if it ignores its folder';
    expect(
      groupNotes([`github: ${unknown}`, "memory: runs @x/memory; turno mcp install pins it", `memory: ${unknown}`, "linear: remote, written directly into profiles", `postgres: ${unknown}`, "db: remote, written directly into profiles"]),
    ).toEqual([
      'scope project for github, memory, postgres (unknown servers: one process per project folder; set scope = "shared" for those that ignore their folder)',
      "memory: runs @x/memory; turno mcp install pins it",
      "linear, db: remote, written directly into profiles",
    ]);
  });
});

describe("style: spinner", () => {
  it("draws on a terminal with the elapsed time and clears its line when done", () => {
    const written: string[] = [];
    let t = 1000;
    const spin = spinner(tty(), "waiting", { tty: true, write: (s) => written.push(s), now: () => t });
    t = 1500;
    expect(spin.stop()).toBe(500);
    expect(written[0]).toContain("waiting");
    expect(written[0]).toContain("0.0s");
    expect(written.at(-1)).toBe("\r\x1b[K");
  });

  it("draws nothing in a pipe or without colors, and still times the step", () => {
    const written: string[] = [];
    let t = 0;
    for (const io of [pipe(), tty({ NO_COLOR: "1" })]) {
      const spin = spinner(io, "waiting", { tty: false, write: (s) => written.push(s), now: () => t });
      t += 250;
      expect(spin.stop()).toBe(250);
    }
    expect(spinner(tty({ NO_COLOR: "1" }), "x", { tty: true, write: (s) => written.push(s) }).stop()).toBeGreaterThanOrEqual(0);
    expect(written).toEqual([]);
  });
});

describe("tildify", () => {
  it("matches HOME with a trailing slash or doubled slashes", () => {
    for (const HOME of ["/home/alice", "/home/alice/", "/home//alice", "/home/alice//"]) {
      expect(tildify("/home/alice/code/x", { HOME }), HOME).toBe("~/code/x");
      expect(tildify("/home/alice", { HOME }), HOME).toBe("~");
    }
    expect(tildify("/home/alice//code", { HOME: "/home/alice" })).toBe("~/code");
    expect(tildify("/home/alicex/code", { HOME: "/home/alice" })).toBe("/home/alicex/code");
    expect(tildify("relative/path", { HOME: "/home/alice" })).toBe("relative/path");
  });
});

describe("undo summary", () => {
  it("groups steps per folder: links counted, single files named, HOME last", () => {
    const env = { HOME: "/h" };
    const steps = [
      ...["skills", "agents", "hooks"].map((d) => ({ path: `/h/.claude-work/${d}`, action: "unlink" as const })),
      { path: "/h/.claude-work/settings.json", action: "move" as const, from: "/h/.claude-work/.aside-1/settings.json" },
      { path: "/h/.claude-work/.aside-1", action: "rmdir" as const },
      { path: "/h/.config/turno/config.toml", action: "restore" as const },
      { path: "/h/.local/bin/claude-work", action: "delete" as const },
      { path: "/h/.claude.json", action: "restore" as const },
      { path: "/h/.claude-work", action: "chmod" as const, mode: 0o755 },
    ];
    expect(summarize(steps, env)).toEqual([
      { folder: "~/.claude-work", skipped: false, text: ["3 links removed", "settings.json moved back", "aside folder removed", "folder mode put back"] },
      { folder: "~/.config/turno", skipped: false, text: ["config.toml restored"] },
      { folder: "~/.local/bin", skipped: false, text: ["claude-work removed"] },
      { folder: "~", skipped: false, text: [".claude.json restored"] },
    ]);
  });
});

describe("screens on a terminal and in a pipe", () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = sandbox();
    sb.env.PATH = `${join(sb.home, ".local/bin")}:/usr/bin:/bin`;
    sb.env.TURNO_NO_UPDATE_CHECK = "1";
    fakeCommand(sb, "claude", `echo '{"loggedIn":true,"email":"alice@example.com","subscriptionType":"max"}'`);
    mkdirSync(join(sb.home, ".claude"), { recursive: true });
    for (const name of ["work", "home"]) {
      mkdirSync(join(sb.home, `.claude-${name}`), { recursive: true });
      writeLauncher(name, sb.env);
    }
    sb.write(".config/turno/config.toml", '[profiles.work]\ncolor = "violet"\n\n[profiles.home]\n');
    sb.write(".local/state/turno/usage/work.json", JSON.stringify({ rate_limits: { five_hour: { used_percentage: 90 }, seven_day: { used_percentage: 30 } } }));
  });
  afterEach(() => sb.cleanup());

  async function screen(args: string[], env: NodeJS.ProcessEnv, isTty: boolean): Promise<string> {
    const io = { ...fakeIo(env), isTty };
    await main(args, io);
    return io.lines.join("\n");
  }

  it("status: sections, pills in the profile color, colored bars and a Next row", async () => {
    const color = await screen(["status"], { ...sb.env, COLUMNS: "120" }, true);
    expect(color).toContain("\x1b[48;5;91;1;38;5;255m work \x1b[0m");
    expect(color).toContain("\x1b[31m━━━━━━━\x1b[0m");
    expect(stripAnsi(color)).toMatch(/^Profiles ─+$/m);
    expect(stripAnsi(color)).toMatch(/^➜ Next {2}turno ui install$/m);
    const plain = await screen(["status"], sb.env, false);
    expect(plain).not.toContain("\x1b[");
    expect(plain).toMatch(/^ {2}work +███████░ +90% +██░░░░░░ +30% +alice@example\.com · max$/m);
    expect(plain).toMatch(/^Next {2}turno ui install$/m);
  });

  it("help: bold title, commands in the accent color, and an Examples block", async () => {
    const color = await screen(["--help"], sb.env, true);
    expect(color).toContain("\x1b[1m\x1b[36minit\x1b[0m\x1b[0m");
    expect(stripAnsi(color)).toMatch(/^Examples ─+$/m);
    const plain = await screen(["--help"], sb.env, false);
    expect(plain).toMatch(/^Examples\n {2}\$ turno init +find your agents/m);
    for (const l of plain.split("\n")) expect(l.length, l).toBeLessThanOrEqual(80);
  });
});

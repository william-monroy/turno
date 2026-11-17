import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCRIPTS } from "../src/cli/commands/completion.js";
import { type Io } from "../src/cli/io.js";
import { writeLauncher } from "../src/cli/launchers.js";
import { main } from "../src/cli/main.js";
import { Journal, listJournals, undoJournal } from "../src/core/journal.js";
import { plistPath } from "../src/mcpd/launchd.js";
import { unitPath } from "../src/mcpd/systemd.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
let calls: string;
const home = (rel: string) => join(sb.home, rel);
const cfgFile = () => home(".config/turno/config.toml");
const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
const callLog = (): string[] => {
  try {
    return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const serviceFile = () => (process.platform === "darwin" ? plistPath(sb.env) : unitPath(sb.env));

beforeEach(() => {
  sb = sandbox();
  sb.env.PATH = `${home(".local/bin")}:/usr/bin:/bin`;
  sb.env.SHELL = "/bin/zsh";
  calls = home("calls.log");
  // Never reach the real service managers: both answer "ok" and record their arguments.
  fakeCommand(sb, "launchctl", `echo "launchctl $*" >> "${calls}"`);
  fakeCommand(sb, "systemctl", `echo "systemctl $*" >> "${calls}"`);
  fakeCommand(sb, "claude", `echo '{"loggedIn":false}'`);
  mkdirSync(home(".claude"), { recursive: true });
  writeFileSync(home(".claude/settings.json"), "{}\n");
});
afterEach(() => sb.cleanup());

async function run(args: string[], io = fakeIo(sb.env)): Promise<{ code: number; io: ReturnType<typeof fakeIo> }> {
  const code = await main(args, io);
  return { code, io };
}

function asking(answer: string): ReturnType<typeof fakeIo> & { asked: string[] } {
  const io = fakeIo(sb.env) as ReturnType<typeof fakeIo> & { asked: string[] };
  io.asked = [];
  (io as Io).ask = async (q: string) => {
    io.asked.push(q);
    return answer;
  };
  return io;
}

describe("journal: links, moves and folders", () => {
  it("records each kind, undoes them in reverse, and the undo can be undone", () => {
    const dir = home("p");
    const hub = home("hub");
    mkdirSync(join(hub, "skills"), { recursive: true });
    mkdirSync(join(dir, "empty"), { recursive: true });
    mkdirSync(join(dir, "old"), { recursive: true });
    symlinkSync(join(hub, "elsewhere"), join(dir, "linked"));
    writeFileSync(join(dir, "mine.json"), "mine\n");
    const j = new Journal(sb.env, "test links");
    j.mkdir(join(dir, "new/deeper"));
    j.rmdir(join(dir, "empty"));
    j.unlink(join(dir, "linked"));
    j.mkdir(join(dir, ".aside-x"));
    j.move(join(dir, "mine.json"), join(dir, ".aside-x/mine.json"));
    j.symlink(join(hub, "skills"), join(dir, "mine.json"));
    expect(isLink(join(dir, "mine.json"))).toBe(true);

    const info = listJournals(sb.env).find((x) => x.stamp === j.stamp)!;
    const { steps, journal } = undoJournal(info, sb.env);
    expect(steps.map((s) => s.action)).toEqual(["unlink", "move", "rmdir", "link", "mkdir", "rmdir", "rmdir"]);
    expect(readFileSync(join(dir, "mine.json"), "utf8")).toBe("mine\n");
    expect(existsSync(join(dir, ".aside-x"))).toBe(false);
    expect(readlinkSync(join(dir, "linked"))).toBe(join(hub, "elsewhere"));
    expect(lstatSync(join(dir, "empty")).isDirectory()).toBe(true);
    expect(existsSync(join(dir, "new"))).toBe(false);

    // Redo: the undo journaled the inverse of each step.
    const redo = listJournals(sb.env).find((x) => x.stamp === journal.stamp)!;
    undoJournal(redo, sb.env);
    expect(isLink(join(dir, "mine.json"))).toBe(true);
    expect(readFileSync(join(dir, ".aside-x/mine.json"), "utf8")).toBe("mine\n");
    expect(existsSync(join(dir, "new/deeper"))).toBe(true);
  });

  it("never overwrites what is there now: a folder with new files is kept, a taken path is skipped", () => {
    const dir = home("q");
    const j = new Journal(sb.env, "test keep");
    j.mkdir(dir);
    j.mkdir(join(dir, ".aside-y"));
    writeFileSync(join(dir, "a"), "a\n");
    j.move(join(dir, "a"), join(dir, ".aside-y/a"));
    writeFileSync(join(dir, "a"), "new\n");
    writeFileSync(join(dir, "login.json"), "{}\n");
    const info = listJournals(sb.env).find((x) => x.stamp === j.stamp)!;
    const { steps } = undoJournal(info, sb.env);
    expect(steps.find((s) => s.action === "skip")?.reason).toMatch(/something is there now/);
    expect(steps.filter((s) => s.action === "keep").length).toBe(2);
    expect(readFileSync(join(dir, "a"), "utf8")).toBe("new\n");
    expect(readFileSync(join(dir, ".aside-y/a"), "utf8")).toBe("a\n");
  });

  it("a dry run of undo changes nothing", () => {
    const j = new Journal(sb.env, "test dry");
    j.mkdir(home("dry"));
    const info = listJournals(sb.env).find((x) => x.stamp === j.stamp)!;
    const { steps } = undoJournal(info, sb.env, { dryRun: true });
    expect(steps.map((s) => s.action)).toEqual(["rmdir"]);
    expect(existsSync(home("dry"))).toBe(true);
  });
});

describe("turno undo after profile add and repair (02-H4)", () => {
  it("undoes a new profile completely: links, launchers, seeded files, the folder and config.toml", async () => {
    sb.write(".config/turno/config.toml", "");
    const r = await run(["profile", "add", "lab"]);
    expect(r.code).toBe(0);
    expect(isLink(home(".claude-lab/skills"))).toBe(true);
    expect(existsSync(home(".local/bin/claude-lab"))).toBe(true);
    expect(existsSync(home(".local/bin/turno-auto"))).toBe(true);
    const v = await run(["undo", "last", "--dry-run", "-v"]);
    expect(v.io.lines).toContain("  ok removed link ~/.claude-lab/skills");
    const u = await run(["undo", "last"]);
    expect(u.code).toBe(0);
    expect(existsSync(home(".claude-lab"))).toBe(false);
    expect(existsSync(home(".local/bin/claude-lab"))).toBe(false);
    expect(existsSync(home(".local/bin/turno-auto"))).toBe(false);
    expect(readFileSync(cfgFile(), "utf8")).not.toContain("[profiles.lab]");
    expect(u.io.lines.join("\n")).toMatch(/^ {2}ok +~\/\.claude-lab +23 links removed, folder removed$/m);
    expect(u.io.lines).toContain("  ok  ~/.local/bin     3 files removed");
  });

  it("moves your own files back from .aside-* and keeps the profile folder", async () => {
    sb.write(".config/turno/config.toml", "");
    mkdirSync(home(".claude-old/skills/mine"), { recursive: true });
    writeFileSync(home(".claude-old/skills/mine/SKILL.md"), "mine\n");
    writeFileSync(home(".claude-old/settings.json"), '{"mine":true}\n');
    const r = await run(["profile", "add", "old", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.io.lines.join("\n")).toContain("turno undo puts them back");
    expect(readdirSync(home(".claude-old")).some((e) => e.startsWith(".aside-"))).toBe(true);
    const u = await run(["undo", "last"]);
    expect(u.code).toBe(0);
    expect(readFileSync(home(".claude-old/settings.json"), "utf8")).toBe('{"mine":true}\n');
    expect(readFileSync(home(".claude-old/skills/mine/SKILL.md"), "utf8")).toBe("mine\n");
    expect(isLink(home(".claude-old/skills"))).toBe(false);
    expect(readdirSync(home(".claude-old")).some((e) => e.startsWith(".aside-"))).toBe(false);
    expect(existsSync(home(".claude-old"))).toBe(true);
  });

  it("never removes a profile folder that holds a login", async () => {
    sb.write(".config/turno/config.toml", "");
    expect((await run(["profile", "add", "lab"])).code).toBe(0);
    writeFileSync(home(".claude-lab/.credentials.json"), "{}\n");
    const u = await run(["undo", "last"]);
    expect(u.code).toBe(0);
    expect(readFileSync(home(".claude-lab/.credentials.json"), "utf8")).toBe("{}\n");
    expect(isLink(home(".claude-lab/skills"))).toBe(false);
    expect(u.io.lines.join("\n")).toMatch(/kept ~\/\.claude-lab: not empty/);
  });

  it("journals profile repair, so a relinked item gets its old link back", async () => {
    sb.write(".config/turno/config.toml", "[profiles.work]\n");
    mkdirSync(home(".claude-work"), { recursive: true });
    writeLauncher("work", sb.env);
    symlinkSync(home("other-skills"), home(".claude-work/skills"));
    const r = await run(["profile", "repair", "work"]);
    expect(r.code).toBe(0);
    expect(r.io.lines.join("\n")).toMatch(/undo with: turno undo \d{8}-\d{6}/);
    expect(readlinkSync(home(".claude-work/skills"))).toBe(home(".claude/skills"));
    expect((await run(["undo", "last"])).code).toBe(0);
    expect(readlinkSync(home(".claude-work/skills"))).toBe(home("other-skills"));
    // The launcher existed and did not change, so it is still there.
    expect(existsSync(home(".local/bin/claude-work"))).toBe(true);
  });

  it("undo --help no longer says profile links and .aside folders are left out", async () => {
    const r = await run(["undo", "--help"]);
    const out = r.io.lines.join("\n");
    expect(out).not.toContain("are not part of it");
    expect(out).toContain(".aside-");
    expect(out).toContain("turno uninstall");
  });
});

/** A machine where turno was set up: two profiles, a gateway entry, the service, the status line. */
function setUpTurno(): void {
  sb.write(".config/turno/config.toml", "[profiles.work]\n");
  sb.write(".config/turno/mcp.toml", "[servers.fs]\ncommand = \"fs\"\n");
  mkdirSync(home(".claude-work"), { recursive: true });
  writeLauncher("work", sb.env);
  sb.write(".local/bin/turno-auto", "#!/bin/sh\n# Generated by turno: auto\nexec turno auto\n");
  sb.write(".local/bin/my-own-tool", "#!/bin/sh\necho mine\n");
  const claudeJson = home(".claude-work/.claude.json");
  writeFileSync(
    claudeJson,
    `${JSON.stringify({ oauthAccount: { emailAddress: "alice@example.com" }, mcpServers: { fs: { type: "http", url: "http://127.0.0.1:1/mcp/fs" }, mine: { command: "mine" } } }, null, 2)}\n`,
  );
  sb.write(".local/state/turno/mcp-managed.json", `${JSON.stringify({ [claudeJson]: ["fs"] })}\n`);
  sb.write(".local/state/turno/mcpd.token", "secret-token-value\n", 0o600);
  sb.write(".local/state/turno/mcpd-tokens/work.token", "tp1.work.x\n", 0o600);
  writeFileSync(home(".claude/settings.json"), `${JSON.stringify({ theme: "dark", statusLine: { type: "command", command: "turno statusline" } }, null, 2)}\n`);
  sb.write(".config/fish/completions/turno.fish", SCRIPTS.fish!);
  sb.write(".zshrc", "export X=1\nsource <(turno completion zsh)\n");
  mkdirSync(join(serviceFile(), ".."), { recursive: true });
  writeFileSync(serviceFile(), "<plist>dev.turno.mcpd</plist>\n");
}

describe("turno uninstall (02-H5)", () => {
  it("--dry-run lists everything and changes nothing", async () => {
    setUpTurno();
    const r = await run(["uninstall", "--dry-run"]);
    expect(r.code).toBe(0);
    const out = r.io.lines.join("\n");
    expect(out).toContain(serviceFile().replace(sb.home, "~"));
    expect(out).toContain("~/.local/bin/claude-work");
    expect(out).toContain("~/.local/bin/turno-auto");
    expect(out).not.toContain("my-own-tool");
    expect(out).toContain("fs from ~/.claude-work/.claude.json");
    expect(out).toContain("statusLine");
    expect(out).toContain("~/.config/fish/completions/turno.fish");
    expect(out).toContain("~/.zshrc line 2");
    expect(out).toContain("~/.config/turno");
    expect(out).toMatch(/~\/\.claude-work .*stays/);
    expect(out).toContain("npm uninstall --global turno-cli");
    expect(out).not.toContain("secret-token-value");
    expect(existsSync(serviceFile())).toBe(true);
    expect(existsSync(home(".local/state/turno/mcpd-tokens/work.token"))).toBe(true);
    expect(existsSync(home(".local/bin/claude-work"))).toBe(true);
    expect(existsSync(cfgFile())).toBe(true);
    expect(callLog()).toEqual([]);
    expect(listJournals(sb.env)).toEqual([]);
  });

  it("refuses without a terminal or --yes, and a no in a terminal changes nothing", async () => {
    setUpTurno();
    const r = await run(["uninstall"]);
    expect(r.code).toBe(2);
    expect(r.io.errors).toEqual(["turno: uninstall needs an answer; pass --yes (or run it in a terminal)"]);
    const no = asking("n");
    expect((await run(["uninstall"], no)).code).toBe(1);
    expect(no.asked).toEqual(["Remove all of this? [y/N] "]);
    expect(existsSync(serviceFile())).toBe(true);
    expect(existsSync(cfgFile())).toBe(true);
    expect(callLog()).toEqual([]);
  });

  it("asks nothing inside an agent session or with --no-input: exit 2, nothing removed", async () => {
    setUpTurno();
    for (const [args, env] of [
      [["uninstall"], { CLAUDECODE: "1" }],
      [["uninstall", "--no-input"], {}],
    ] as const) {
      const io = asking("y");
      io.env = { ...io.env, ...env };
      const r = await run([...args], io);
      expect(io.asked).toEqual([]);
      expect(r.code).toBe(2);
      expect(r.io.errors).toEqual(["turno: uninstall needs an answer; pass --yes (or run it in a terminal)"]);
    }
    expect(existsSync(serviceFile())).toBe(true);
    expect(existsSync(cfgFile())).toBe(true);
    expect(callLog()).toEqual([]);
    expect(listJournals(sb.env)).toEqual([]);
  });

  it("removes what turno set up, keeps profile folders and your own entries, and undo puts it back", async () => {
    setUpTurno();
    const yes = asking("y");
    const r = await run(["uninstall"], yes);
    expect(r.code).toBe(0);
    expect(existsSync(serviceFile())).toBe(false);
    expect(callLog().some((l) => /bootout|disable --now/.test(l))).toBe(true);
    expect(existsSync(home(".local/bin/claude-work"))).toBe(false);
    expect(existsSync(home(".local/bin/turno-auto"))).toBe(false);
    expect(existsSync(home(".local/bin/my-own-tool"))).toBe(true);
    const cj = JSON.parse(readFileSync(home(".claude-work/.claude.json"), "utf8"));
    expect(Object.keys(cj.mcpServers)).toEqual(["mine"]);
    expect(cj.oauthAccount).toEqual({ emailAddress: "alice@example.com" });
    const settings = JSON.parse(readFileSync(home(".claude/settings.json"), "utf8"));
    expect(settings).toEqual({ theme: "dark" });
    expect(existsSync(home(".config/fish/completions/turno.fish"))).toBe(false);
    expect(readFileSync(home(".zshrc"), "utf8")).toContain("turno completion zsh");
    expect(existsSync(home(".config/turno"))).toBe(false);
    expect(existsSync(home(".local/state/turno/mcpd.token"))).toBe(false);
    expect(existsSync(home(".local/state/turno/mcpd-tokens/work.token"))).toBe(false);
    expect(existsSync(home(".claude-work"))).toBe(true);
    const out = r.io.lines.join("\n");
    expect(out).toMatch(/turno undo \d{8}-\d{6}/);
    expect(out).toContain("npm uninstall --global turno-cli");

    const u = await run(["undo", "last"]);
    expect(u.code).toBe(0);
    expect(existsSync(serviceFile())).toBe(true);
    expect(existsSync(home(".local/bin/claude-work"))).toBe(true);
    expect(readFileSync(cfgFile(), "utf8")).toBe("[profiles.work]\n");
    expect(existsSync(home(".config/turno/mcp.toml"))).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(home(".claude-work/.claude.json"), "utf8")).mcpServers)).toEqual(["fs", "mine"]);
    expect(JSON.parse(readFileSync(home(".claude/settings.json"), "utf8")).statusLine.command).toBe("turno statusline");
  });

  it("--yes runs without a terminal; --keep-config keeps ~/.config/turno", async () => {
    setUpTurno();
    const r = await run(["uninstall", "--yes", "--keep-config"]);
    expect(r.code).toBe(0);
    expect(readFileSync(cfgFile(), "utf8")).toBe("[profiles.work]\n");
    expect(existsSync(home(".local/bin/claude-work"))).toBe(false);
    expect(r.io.lines.join("\n")).toContain("~/.config/turno stays");
  });

  it("puts back the status line you had before turno ui install", async () => {
    writeFileSync(home(".claude/settings.json"), `${JSON.stringify({ statusLine: { type: "command", command: "my-line" } })}\n`);
    const j = new Journal(sb.env, "ui install --no-font");
    j.write(home(".claude/settings.json"), `${JSON.stringify({ statusLine: { type: "command", command: "turno statusline" } })}\n`);
    const r = await run(["uninstall", "--yes"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(home(".claude/settings.json"), "utf8")).statusLine).toEqual({ type: "command", command: "my-line" });
  });

  it("with nothing set up, says so", async () => {
    const r = await run(["uninstall", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.io.lines.join("\n")).toContain("Nothing of turno's to remove");
    expect(callLog()).toEqual([]);
  });
});

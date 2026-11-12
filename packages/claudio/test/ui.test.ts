import { lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as fontsPkg from "@claudio/fonts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useNerd } from "../src/cli/commands/statusline.js";
import { statusLineCommand, command as ui } from "../src/cli/commands/ui.js";
import { legacyToToml, parseLegacy } from "../src/cli/commands/migrate.js";
import { parseConfig } from "../src/core/config.js";
import { NERD } from "../src/statusline/render.js";
import { codePoints } from "../src/ui/cmap.js";
import { FALLBACK, type FontSource, checkFonts, fontSource, installFonts, sha256 } from "../src/ui/fonts.js";
import { isClaudioStatusLine, setStatusLine, withNerdTerminals } from "../src/ui/settings.js";
import { currentTerminal, nerdHere } from "../src/ui/terminal-id.js";
import { detectNerdTerminals, isNerdFamily, jsoncGet, jsoncSet, tomlGet, tomlSet } from "../src/ui/terminals.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  sb.env.CLAUDIO_APPS_DIR = join(sb.home, "Applications");
  sb.env.CLAUDIO_FONT_DIR = join(sb.home, "fonts");
});
afterEach(() => sb.cleanup());

describe("bundled font", () => {
  it("matches the checksums claudio pins and draws every status line icon", () => {
    expect(fontsPkg.FONTS).toEqual(FALLBACK.files);
    expect(fontsPkg.FAMILY).toBe(FALLBACK.family);
    expect(fontsPkg.VERSION).toBe(FALLBACK.version);
    for (const f of fontsPkg.FONTS) expect(sha256(readFileSync(join(fontsPkg.fontsDir, f.file)))).toBe(f.sha256);
    for (const f of fontsPkg.FONTS) {
      const have = codePoints(readFileSync(join(fontsPkg.fontsDir, f.file)));
      const missing = Object.entries(NERD).filter(([, g]) => !have.has(g.codePointAt(0)!));
      expect(missing, f.file).toEqual([]);
      expect(have.has(0x41)).toBe(true);
    }
  });

  it("is found through the optional package", async () => {
    const s = await fontSource();
    expect(s.dir).toBe(fontsPkg.fontsDir);
  });
});

describe("installFonts", () => {
  it("copies, keeps what is there, and skips a different file unless forced", async () => {
    const dir = join(sb.home, "fonts");
    const source = await fontSource();
    const dry = await installFonts(source, { dir, dryRun: true });
    expect(dry.map((r) => r.action)).toEqual(["copied", "copied", "copied", "copied"]);
    expect(() => readdirSync(dir)).toThrow();

    const first = await installFonts(source, { dir });
    expect(first.every((r) => r.action === "copied")).toBe(true);
    expect(checkFonts(source, dir).every((c) => c.state === "installed")).toBe(true);
    expect((await installFonts(source, { dir })).every((r) => r.action === "kept")).toBe(true);

    writeFileSync(join(dir, "MesloLGSNerdFont-Bold.ttf"), "something else");
    const again = await installFonts(source, { dir });
    expect(again.find((r) => r.file === "MesloLGSNerdFont-Bold.ttf")?.action).toBe("skipped");
    const forced = await installFonts(source, { dir, force: true });
    expect(forced.find((r) => r.file === "MesloLGSNerdFont-Bold.ttf")?.action).toBe("copied");
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("downloads without the package and refuses bytes that fail the checksum", async () => {
    const dir = join(sb.home, "dl");
    const good: FontSource = { ...FALLBACK };
    const urls: string[] = [];
    const fetchOk = (async (url: string) => {
      urls.push(url);
      const f = FALLBACK.files.find((x) => x.url === url)!;
      return new Response(readFileSync(join(fontsPkg.fontsDir, f.file)));
    }) as unknown as typeof fetch;
    const res = await installFonts(good, { dir, fetch: fetchOk });
    expect(res.every((r) => r.action === "downloaded")).toBe(true);
    expect(urls[0]).toBe("https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/patched-fonts/Meslo/S/Regular/MesloLGSNerdFont-Regular.ttf");

    const bad = (async () => new Response("not a font")) as unknown as typeof fetch;
    await expect(installFonts(good, { dir: join(sb.home, "bad"), fetch: bad })).rejects.toThrow(/checksum mismatch/);
    expect(() => readdirSync(join(sb.home, "bad"))).toThrow();
  });
});

describe("terminals", () => {
  it("tells the terminal from the environment", () => {
    expect(currentTerminal({ TERM_PROGRAM: "WarpTerminal" })).toBe("warp");
    expect(currentTerminal({ TERM_PROGRAM: "vscode" })).toBe("vscode");
    expect(currentTerminal({ TERM_PROGRAM: "vscode", CURSOR_TRACE_ID: "x" })).toBe("cursor");
    expect(currentTerminal({ TERM_PROGRAM: "vscode", __CFBundleIdentifier: "com.todesktop.230313mzl4w4u92" })).toBe("cursor");
    expect(currentTerminal({ TERM: "xterm-kitty" })).toBe("kitty");
    expect(currentTerminal({ ALACRITTY_WINDOW_ID: "1" })).toBe("alacritty");
    expect(currentTerminal({ TERM_PROGRAM: "Orca" })).toBe("orca");
    expect(currentTerminal({})).toBeUndefined();
  });

  it("uses Nerd icons where the terminal ships them or a Nerd Font is recorded", () => {
    const cfg = parseConfig("");
    expect(useNerd(cfg, { TERM_PROGRAM: "ghostty" })).toBe(true);
    expect(useNerd(cfg, { TERM_PROGRAM: "WarpTerminal" })).toBe(false);
    expect(useNerd(parseConfig('nerd_terminals = ["warp"]'), { TERM_PROGRAM: "WarpTerminal" })).toBe(true);
    expect(useNerd(parseConfig('icons = "unicode"'), { TERM_PROGRAM: "ghostty" })).toBe(false);
    expect(useNerd(parseConfig('icons = "nerd"'), {})).toBe(true);
    expect(nerdHere({}, ["warp"])).toBe(false);
    expect(() => parseConfig("nerd_terminals = 3")).toThrow(/nerd_terminals/);
  });

  it("recognizes Nerd Font family names", () => {
    expect(isNerdFamily("MesloLGS NF")).toBe(true);
    expect(isNerdFamily("'CaskaydiaCove Nerd Font'")).toBe(true);
    expect(isNerdFamily("JetBrainsMono NFM")).toBe(true);
    expect(isNerdFamily("monospace")).toBe(false);
    expect(isNerdFamily("Menlo")).toBe(false);
  });

  it("edits a TOML section in place", () => {
    const warp = '[appearance.text]\nnotebook_font_size = 14.0\nfont_name = "Hack"\n\n[agents]\nx = 1\n';
    expect(tomlGet(warp, "appearance.text", "font_name")).toBe("Hack");
    const set = tomlSet(warp, "appearance.text", "font_name", "MesloLGS NF");
    expect(set).toBe('[appearance.text]\nnotebook_font_size = 14.0\nfont_name = "MesloLGS NF"\n\n[agents]\nx = 1\n');
    const added = tomlSet('[appearance.text]\nfont_size = 13.0\n\n[agents]\n', "appearance.text", "font_name", "MesloLGS NF");
    expect(added).toBe('[appearance.text]\nfont_size = 13.0\nfont_name = "MesloLGS NF"\n\n[agents]\n');
    expect(tomlSet("", "font.normal", "family", "MesloLGS NF")).toBe('[font.normal]\nfamily = "MesloLGS NF"\n');
    expect(tomlSet("a = 1", "font.normal", "family", "X")).toBe('a = 1\n\n[font.normal]\nfamily = "X"\n');
    expect(tomlGet("[agents]\nfont_name = \"x\"\n", "appearance.text", "font_name")).toBeUndefined();
  });

  it("edits VS Code settings without touching comments", () => {
    const text = '{\n  // my terminal\n  "terminal.integrated.fontFamily": "monospace",\n  "editor.fontSize": 13,\n}\n';
    expect(jsoncGet(text, "terminal.integrated.fontFamily")).toBe("monospace");
    expect(jsoncSet(text, "terminal.integrated.fontFamily", "MesloLGS NF")).toBe(
      '{\n  // my terminal\n  "terminal.integrated.fontFamily": "MesloLGS NF",\n  "editor.fontSize": 13,\n}\n',
    );
    expect(jsoncSet('{\n  "a": 1\n}\n', "terminal.integrated.fontFamily", "X")).toBe('{\n  "terminal.integrated.fontFamily": "X",\n  "a": 1\n}\n');
    expect(jsoncSet("{}", "terminal.integrated.fontFamily", "X")).toBe('{\n  "terminal.integrated.fontFamily": "X"}');
    expect(jsoncSet("", "k", "X")).toBe('{\n  "k": "X"\n}\n');
  });

  it("detects terminals that already use a Nerd Font", () => {
    sb.write(".warp/settings.toml", '[appearance.text]\nfont_name = "MesloLGS NF"\n');
    sb.write("Library/Application Support/Code/User/settings.json", '{ "terminal.integrated.fontFamily": "monospace" }');
    expect(detectNerdTerminals(sb.env, "darwin")).toEqual(["warp"]);
  });
});

describe("settings", () => {
  it("points the hub status line at claudio through the profile symlinks", () => {
    const hub = sb.write(".claude/settings.json", JSON.stringify({ theme: "dark", statusLine: { type: "command", command: "python3 ~/x.py", padding: 1 } }));
    mkdirSync(join(sb.home, ".claude-work"));
    symlinkSync(hub, join(sb.home, ".claude-work", "settings.json"));
    const r = setStatusLine(join(sb.home, ".claude-work", "settings.json"), "~/.local/bin/claudio statusline", { backupDir: join(sb.home, "bk") });
    expect(r.changed).toBe(true);
    expect(r.file).toBe(hub);
    expect(lstatSync(join(sb.home, ".claude-work", "settings.json")).isSymbolicLink()).toBe(true);
    const after = JSON.parse(readFileSync(hub, "utf8"));
    expect(after).toEqual({ theme: "dark", statusLine: { type: "command", command: "~/.local/bin/claudio statusline", padding: 1, refreshInterval: 30 } });
    expect(JSON.parse(readFileSync(join(sb.home, "bk", "settings.json"), "utf8")).statusLine.command).toBe("python3 ~/x.py");
    expect(setStatusLine(hub, "~/.local/bin/claudio statusline").changed).toBe(false);
    expect(isClaudioStatusLine(after.statusLine)).toBe(true);
    expect(isClaudioStatusLine({ type: "command", command: "python3 ~/.claude/statusline-claudio.py" })).toBe(false);
  });

  it("sets nerd_terminals before the first table and replaces it later", () => {
    const text = "# hi\nsystem = \"work\"\n\n[open]\nchrome_dir = \"x\"\n";
    const one = withNerdTerminals(text, ["warp"]);
    expect(one).toBe('# hi\nsystem = "work"\nnerd_terminals = ["warp"]\n\n[open]\nchrome_dir = "x"\n');
    expect(withNerdTerminals(one, ["vscode", "warp"])).toBe('# hi\nsystem = "work"\nnerd_terminals = ["vscode", "warp"]\n\n[open]\nchrome_dir = "x"\n');
    expect(withNerdTerminals("", ["warp"])).toBe('nerd_terminals = ["warp"]\n');
    expect(parseConfig(one).nerdTerminals).toEqual(["warp"]);
  });

  it("migrate keeps Nerd icons in a terminal that has a Nerd Font", () => {
    const toml = legacyToToml(parseLegacy("sistema work\n", ""), undefined, ["warp"]);
    expect(parseConfig(toml).nerdTerminals).toEqual(["warp"]);
  });
});

describe("claudio ui", () => {
  it("install sets up font, status line, terminal font and config, and status reports it", async () => {
    fakeCommand(sb, "claudio", "exit 0");
    sb.write(".claude/settings.json", JSON.stringify({ statusLine: { type: "command", command: "python3 ~/.claude/statusline-claudio.py", refreshInterval: 30 } }));
    sb.write(".warp/settings.toml", '[appearance.text]\nfont_size = 19.0\nfont_name = "Hack"\n');
    sb.write(".config/claudio/config.toml", 'system = "work"\n\n[profiles.work]\nbrowser = "chrome"\n');
    sb.env.TERM_PROGRAM = "WarpTerminal";

    const dry = fakeIo(sb.env);
    expect(await ui.run(["install", "--terminal", "current", "--dry-run"], dry)).toBe(0);
    expect(dry.lines.join("\n")).toContain("(dry run)");
    expect(readFileSync(join(sb.home, ".warp/settings.toml"), "utf8")).toContain('"Hack"');
    expect(() => readdirSync(join(sb.home, "fonts"))).toThrow();

    const io = fakeIo(sb.env);
    expect(await ui.run(["install", "--terminal", "current"], io)).toBe(0);
    const out = io.lines.join("\n");
    expect(out).toContain("font: MesloLGSNerdFont-Regular.ttf installed");
    expect(out).toContain("statusline: ");
    expect(out).toContain("Warp: font Hack -> MesloLGS Nerd Font");
    expect(out).toContain("config: nerd_terminals = [warp]");
    expect(readFileSync(join(sb.home, ".warp/settings.toml"), "utf8")).toContain('font_name = "MesloLGS Nerd Font"');
    const settings = JSON.parse(readFileSync(join(sb.home, ".claude/settings.json"), "utf8"));
    expect(settings.statusLine.command).toBe(`${join(sb.home, "fakebin", "claudio")} statusline`.replace(sb.home, "~"));
    const backups = join(sb.home, ".local/state/claudio/backups");
    const [st] = readdirSync(backups);
    expect(readdirSync(join(backups, st!, "ui")).sort()).toEqual(["claude", "config", "warp"]);

    const again = fakeIo(sb.env);
    await ui.run(["install"], again);
    expect(again.lines.join("\n")).toContain("already runs");
    expect(again.lines.join("\n")).not.toContain("config:");

    const status = fakeIo(sb.env);
    expect(await ui.run(["status"], status)).toBe(0);
    const s = status.lines.join("\n");
    expect(s).toContain("MesloLGS Nerd Font installed");
    expect(s).toContain(`has all ${Object.keys(NERD).length} status line icons`);
    expect(s).toContain("Warp (this one): font MesloLGS Nerd Font, Nerd icons");
    expect(s).toContain("icons     auto: Nerd here");
  });

  it("never points the status line at the bash claudio", () => {
    fakeCommand(sb, "claudio", "# the bash claudio\nexit 0");
    const legacy = join(sb.home, "fakebin", "claudio");
    writeFileSync(legacy, "#!/bin/bash\n# claudio: several accounts\n");
    const self = sb.write("repo/dist/cli/main.js", "#!/usr/bin/env node\n");
    expect(statusLineCommand(sb.env, self)).toBe("~/repo/dist/cli/main.js statusline");
    writeFileSync(legacy, "#!/usr/bin/env node\n");
    expect(statusLineCommand(sb.env, self)).toBe("~/fakebin/claudio statusline");
  });

  it("suggests the bundled font where an older Nerd Font is set", async () => {
    sb.write(".warp/settings.toml", '[appearance.text]\nfont_name = "MesloLGS NF"\n');
    const io = fakeIo(sb.env);
    await ui.run(["status"], io);
    expect(io.lines.join("\n")).toContain("Warp: font MesloLGS NF, Unicode icons (claudio ui install records it)");
    sb.write(".config/claudio/config.toml", 'nerd_terminals = ["warp"]\n');
    const io2 = fakeIo(sb.env);
    await ui.run(["status"], io2);
    expect(io2.lines.join("\n")).toContain("Nerd icons (claudio ui install --terminal warp switches it to MesloLGS Nerd Font)");
  });

  it("rejects unknown terminals and options", async () => {
    await expect(ui.run(["install", "--terminal", "nope"], fakeIo(sb.env))).rejects.toThrow(/unknown terminal/);
    await expect(ui.run(["install", "--what"], fakeIo(sb.env))).rejects.toThrow(/unknown option/);
    await expect(ui.run(["install", "--terminal", "current"], fakeIo(sb.env))).rejects.toThrow(/could not tell/);
  });
});

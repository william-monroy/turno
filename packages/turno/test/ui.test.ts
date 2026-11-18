import { lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as fontsPkg from "turno-fonts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useNerd } from "../src/cli/commands/statusline.js";
import { statusLineCommand, command as ui } from "../src/cli/commands/ui.js";
import { legacyToToml, parseLegacy } from "../src/cli/commands/migrate.js";
import { parseConfig } from "../src/core/config.js";
import { NERD } from "../src/statusline/render.js";
import { codePoints } from "../src/ui/cmap.js";
import { FALLBACK, type FontSource, checkFonts, fontSource, installFonts, sha256 } from "../src/ui/fonts.js";
import { Journal } from "../src/core/journal.js";
import { isTurnoStatusLine, setStatusLine, statusLineLabel, withNerdTerminals } from "../src/ui/settings.js";
import { currentTerminal, nerdHere } from "../src/ui/terminal-id.js";
import { detectNerdTerminals, isNerdFamily, jsoncGet, jsoncSet, tomlGet, tomlSet } from "../src/ui/terminals.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  sb.env.TURNO_APPS_DIR = join(sb.home, "Applications");
  sb.env.TURNO_FONT_DIR = join(sb.home, "fonts");
});
afterEach(() => sb.cleanup());

describe("bundled font", () => {
  it("matches the checksums turno pins and draws every status line icon", () => {
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

  it("is found through turno-fonts when that package is installed", async () => {
    const s = await fontSource();
    expect(s.dir).toBe(fontsPkg.fontsDir);
  });
});

describe("installFonts", () => {
  it("copies, keeps what is there, and skips a different file unless forced", async () => {
    const dir = join(sb.home, "fonts");
    const source = await fontSource();
    const dry = await installFonts(source, { env: sb.env, dir, dryRun: true });
    expect(dry.map((r) => r.action)).toEqual(["copied", "copied", "copied", "copied"]);
    expect(() => readdirSync(dir)).toThrow();

    const first = await installFonts(source, { env: sb.env, dir });
    expect(first.every((r) => r.action === "copied")).toBe(true);
    expect(checkFonts(source, dir).every((c) => c.state === "installed")).toBe(true);
    expect((await installFonts(source, { env: sb.env, dir })).every((r) => r.action === "kept")).toBe(true);

    writeFileSync(join(dir, "MesloLGSNerdFont-Bold.ttf"), "something else");
    const again = await installFonts(source, { env: sb.env, dir });
    expect(again.find((r) => r.file === "MesloLGSNerdFont-Bold.ttf")?.action).toBe("skipped");
    const forced = await installFonts(source, { env: sb.env, dir, force: true });
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
    const res = await installFonts(good, { env: sb.env, dir, fetch: fetchOk });
    expect(res.every((r) => r.action === "downloaded")).toBe(true);
    expect(urls[0]).toBe(
      "https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/patched-fonts/Meslo/S/Regular/MesloLGSNerdFont-Regular.ttf",
    );

    const bad = (async () => new Response("not a font")) as unknown as typeof fetch;
    await expect(installFonts(good, { env: sb.env, dir: join(sb.home, "bad"), fetch: bad })).rejects.toThrow(
      /checksum mismatch/,
    );
    expect(() => readdirSync(join(sb.home, "bad"))).toThrow();
  });
});

describe("installFonts on Linux", () => {
  it("runs fc-cache with the install env, so its cache lands under that HOME", async () => {
    fakeCommand(
      sb,
      "fc-cache",
      'mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}/fontconfig" && echo "$HOME" > "${XDG_CACHE_HOME:-$HOME/.cache}/fontconfig/seen"',
    );
    const dir = join(sb.home, ".local/share/fonts");
    await installFonts(await fontSource(), { dir, platform: "linux", env: sb.env });
    expect(readFileSync(join(sb.home, ".cache/fontconfig/seen"), "utf8").trim()).toBe(sb.home);
  });
});

describe("terminals", () => {
  it("tells the terminal from the environment", () => {
    expect(currentTerminal({ TERM_PROGRAM: "WarpTerminal" })).toBe("warp");
    expect(currentTerminal({ TERM_PROGRAM: "vscode" })).toBe("vscode");
    expect(currentTerminal({ TERM_PROGRAM: "vscode", CURSOR_TRACE_ID: "x" })).toBe("cursor");
    expect(currentTerminal({ TERM_PROGRAM: "vscode", __CFBundleIdentifier: "com.todesktop.230313mzl4w4u92" })).toBe(
      "cursor",
    );
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
    const added = tomlSet(
      "[appearance.text]\nfont_size = 13.0\n\n[agents]\n",
      "appearance.text",
      "font_name",
      "MesloLGS NF",
    );
    expect(added).toBe('[appearance.text]\nfont_size = 13.0\nfont_name = "MesloLGS NF"\n\n[agents]\n');
    expect(tomlSet("", "font.normal", "family", "MesloLGS NF")).toBe('[font.normal]\nfamily = "MesloLGS NF"\n');
    expect(tomlSet("a = 1", "font.normal", "family", "X")).toBe('a = 1\n\n[font.normal]\nfamily = "X"\n');
    expect(tomlGet('[agents]\nfont_name = "x"\n', "appearance.text", "font_name")).toBeUndefined();
  });

  it("edits VS Code settings without touching comments", () => {
    const text = '{\n  // my terminal\n  "terminal.integrated.fontFamily": "monospace",\n  "editor.fontSize": 13,\n}\n';
    expect(jsoncGet(text, "terminal.integrated.fontFamily")).toBe("monospace");
    expect(jsoncSet(text, "terminal.integrated.fontFamily", "MesloLGS NF")).toBe(
      '{\n  // my terminal\n  "terminal.integrated.fontFamily": "MesloLGS NF",\n  "editor.fontSize": 13,\n}\n',
    );
    expect(jsoncSet('{\n  "a": 1\n}\n', "terminal.integrated.fontFamily", "X")).toBe(
      '{\n  "terminal.integrated.fontFamily": "X",\n  "a": 1\n}\n',
    );
    expect(jsoncSet("{}", "terminal.integrated.fontFamily", "X")).toBe('{\n  "terminal.integrated.fontFamily": "X"}');
    expect(jsoncSet("", "k", "X")).toBe('{\n  "k": "X"\n}\n');
  });

  it("detects terminals that already use a Nerd Font", () => {
    sb.write(".warp/settings.toml", '[appearance.text]\nfont_name = "MesloLGS NF"\n');
    sb.write(
      "Library/Application Support/Code/User/settings.json",
      '{ "terminal.integrated.fontFamily": "monospace" }',
    );
    expect(detectNerdTerminals(sb.env, "darwin")).toEqual(["warp"]);
  });
});

describe("settings", () => {
  it("points the hub status line at turno through the profile symlinks", () => {
    const hub = sb.write(
      ".claude/settings.json",
      JSON.stringify({ theme: "dark", statusLine: { type: "command", command: "python3 ~/x.py", padding: 1 } }),
    );
    mkdirSync(join(sb.home, ".claude-work"));
    symlinkSync(hub, join(sb.home, ".claude-work", "settings.json"));
    const journal = new Journal(sb.env, "test");
    const r = setStatusLine(join(sb.home, ".claude-work", "settings.json"), "~/.local/bin/turno statusline", journal);
    expect(r.changed).toBe(true);
    expect(r.file).toBe(hub);
    expect(lstatSync(join(sb.home, ".claude-work", "settings.json")).isSymbolicLink()).toBe(true);
    const after = JSON.parse(readFileSync(hub, "utf8"));
    expect(after).toEqual({
      theme: "dark",
      statusLine: { type: "command", command: "~/.local/bin/turno statusline", padding: 1, refreshInterval: 30 },
    });
    expect(JSON.parse(readFileSync(join(journal.dir, "files", "0-settings.json"), "utf8")).statusLine.command).toBe(
      "python3 ~/x.py",
    );
    expect(setStatusLine(hub, "~/.local/bin/turno statusline", journal).changed).toBe(false);
    expect(isTurnoStatusLine(after.statusLine)).toBe(true);
    expect(isTurnoStatusLine({ type: "command", command: "python3 ~/.claude/statusline-claudio.py" })).toBe(false);
  });

  it("knows turno's status line when its path is quoted, as turno demo writes it", () => {
    const cmd = (command: string) => ({ type: "command" as const, command });
    expect(isTurnoStatusLine(cmd('"/tmp/turno-demo-x/.local/bin/turno" statusline'))).toBe(true);
    expect(isTurnoStatusLine(cmd("'/opt/my tools/turno' statusline --plain"))).toBe(true);
    expect(isTurnoStatusLine(cmd("turno statusline"))).toBe(true);
    expect(isTurnoStatusLine(cmd("myturno statusline"))).toBe(false);
    expect(isTurnoStatusLine(cmd("turno statuslines"))).toBe(false);
  });

  it("labels a status line for one row: turno's by name, another tildified, unquoted and cut", () => {
    const env = { HOME: "/home/alice" };
    const cmd = (command: string) => ({ type: "command" as const, command });
    expect(statusLineLabel(cmd('"/tmp/turno-demo-x/.local/bin/turno" statusline'), env)).toBe("turno statusline");
    expect(statusLineLabel(undefined, env)).toBe("none");
    expect(statusLineLabel(cmd('python3 "/home/alice/.claude/line.py"'), env)).toBe("python3 ~/.claude/line.py");
    const long = statusLineLabel(cmd(`node /home/alice/${"x".repeat(80)}.js --flag`), env, 40);
    expect(long).toHaveLength(40);
    expect(long).toMatch(/^node ~\/x+\.\.\.$/);
  });

  it("sets nerd_terminals before the first table and replaces it later", () => {
    const text = '# hi\nsystem = "work"\n\n[open]\nchrome_dir = "x"\n';
    const one = withNerdTerminals(text, ["warp"]);
    expect(one).toBe('# hi\nsystem = "work"\nnerd_terminals = ["warp"]\n\n[open]\nchrome_dir = "x"\n');
    expect(withNerdTerminals(one, ["vscode", "warp"])).toBe(
      '# hi\nsystem = "work"\nnerd_terminals = ["vscode", "warp"]\n\n[open]\nchrome_dir = "x"\n',
    );
    expect(withNerdTerminals("", ["warp"])).toBe('nerd_terminals = ["warp"]\n');
    expect(parseConfig(one).nerdTerminals).toEqual(["warp"]);
  });

  it("migrate keeps Nerd icons in a terminal that has a Nerd Font", () => {
    const toml = legacyToToml(parseLegacy("sistema work\n", ""), undefined, ["warp"]);
    expect(parseConfig(toml).nerdTerminals).toEqual(["warp"]);
  });
});

describe("turno ui", () => {
  it("install sets up font, status line, terminal font and config, and status reports it", async () => {
    fakeCommand(sb, "turno", "exit 0");
    sb.write(
      ".claude/settings.json",
      JSON.stringify({
        statusLine: { type: "command", command: "python3 ~/.claude/statusline-claudio.py", refreshInterval: 30 },
      }),
    );
    sb.write(".warp/settings.toml", '[appearance.text]\nfont_size = 19.0\nfont_name = "Hack"\n');
    sb.write(".config/turno/config.toml", 'system = "work"\n\n[profiles.work]\nbrowser = "chrome"\n');
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
    expect(settings.statusLine.command).toBe(`${join(sb.home, "fakebin", "turno")} statusline`.replace(sb.home, "~"));
    const { listJournals } = await import("../src/core/journal.js");
    const [journal] = listJournals(sb.env);
    const touched = journal!.manifest!.entries.map((e) => e.path.replace(sb.home, "~"));
    expect(touched).toEqual(
      expect.arrayContaining([
        "~/.claude/settings.json",
        "~/.warp/settings.toml",
        "~/.config/turno/config.toml",
        "~/fonts/MesloLGSNerdFont-Regular.ttf",
      ]),
    );
    expect(out).toContain(`undo with: turno undo ${journal!.stamp}`);

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
    fakeCommand(sb, "turno", "# the bash claudio\nexit 0");
    const legacy = join(sb.home, "fakebin", "turno");
    writeFileSync(legacy, "#!/bin/bash\n# turno: several accounts\n");
    const self = sb.write("repo/dist/cli/main.js", "#!/usr/bin/env node\n");
    expect(statusLineCommand(sb.env, self)).toBe("~/repo/dist/cli/main.js statusline");
    writeFileSync(legacy, "#!/usr/bin/env node\n");
    expect(statusLineCommand(sb.env, self)).toBe("~/fakebin/turno statusline");
  });

  it("suggests the bundled font where an older Nerd Font is set", async () => {
    sb.write(".warp/settings.toml", '[appearance.text]\nfont_name = "MesloLGS NF"\n');
    const io = fakeIo(sb.env);
    await ui.run(["status"], io);
    expect(io.lines.join("\n")).toContain("Warp: font MesloLGS NF, Unicode icons (turno ui install records it)");
    sb.write(".config/turno/config.toml", 'nerd_terminals = ["warp"]\n');
    const io2 = fakeIo(sb.env);
    await ui.run(["status"], io2);
    expect(io2.lines.join("\n")).toContain(
      "Nerd icons (turno ui install --terminal warp switches it to MesloLGS Nerd Font)",
    );
  });

  it("leaves config.toml to migrate while the legacy config is still there", async () => {
    sb.write(".config/claudio/proyectos", "work ~/code\n");
    sb.write(".warp/settings.toml", '[appearance.text]\nfont_name = "Hack"\n');
    const io = fakeIo(sb.env);
    expect(await ui.run(["install", "--no-statusline", "--terminal", "warp"], io)).toBe(0);
    expect(io.lines.join("\n")).toContain("config: no config.toml yet; turno migrate records nerd_terminals = [warp]");
    expect(() => lstatSync(join(sb.home, ".config/turno/config.toml"))).toThrow();
    const status = fakeIo(sb.env);
    await ui.run(["status"], status);
    expect(status.lines.join("\n")).toContain(
      "Warp: font MesloLGS Nerd Font, Unicode icons (turno migrate records it)",
    );
  });

  it("rejects unknown terminals and options", async () => {
    await expect(ui.run(["install", "--terminal", "nope"], fakeIo(sb.env))).rejects.toThrow(/unknown terminal/);
    await expect(ui.run(["install", "--what"], fakeIo(sb.env))).rejects.toThrow(/unknown option/);
    await expect(ui.run(["install", "--terminal", "current"], fakeIo(sb.env))).rejects.toThrow(/could not tell/);
  });
});

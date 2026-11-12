import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bool, count, parseFlags } from "../src/cli/args.js";
import { complete } from "../src/cli/commands/complete.js";
import { SCRIPTS } from "../src/cli/commands/completion.js";
import { command as config, parseValue } from "../src/cli/commands/config.js";
import { doctor } from "../src/cli/commands/doctor.js";
import { parseDuration } from "../src/cli/commands/limit.js";
import { command as profile } from "../src/cli/commands/profile.js";
import { changesSince, finishUpgrade, recordedVersion } from "../src/cli/commands/upgrade.js";
import { command as undo } from "../src/cli/commands/undo.js";
import { writeLauncher } from "../src/cli/launchers.js";
import { main } from "../src/cli/main.js";
import { loadConfig } from "../src/core/config.js";
import { Journal, listJournals, undoJournal } from "../src/core/journal.js";
import { addArrayTable, ensureTable, removeArrayTables, removeTable, removeValue, setValue } from "../src/core/toml-edit.js";
import { fetchLatest, registryUrl, updateChecksOff, updateNotice } from "../src/core/update.js";
import { compareVersions, detectInstall, packageInfo, upgradeCommand } from "../src/core/version.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  mkdirSync(join(sb.home, ".claude"), { recursive: true });
  for (const name of ["work", "personal"]) {
    mkdirSync(join(sb.home, `.claude-${name}`), { recursive: true });
    writeLauncher(name, sb.env);
  }
  fakeCommand(sb, "claude", `echo '{"loggedIn":false}'`);
});
afterEach(() => sb.cleanup());

const cfg = () => readFileSync(join(sb.home, ".config/turno/config.toml"), "utf8");

describe("flags", () => {
  it("parses long, short and = forms and rejects unknown ones plainly", () => {
    const p = parseFlags(["a", "--json", "-n", "5", "--until=x"], { json: { type: "boolean" }, tail: { type: "string", short: "n" }, until: { type: "string" } });
    expect(p.positionals).toEqual(["a"]);
    expect(bool(p, "json")).toBe(true);
    expect(count(p, "tail", 1)).toBe(5);
    expect(() => parseFlags(["--nope"], {})).toThrow("unknown option --nope");
    expect(() => parseFlags(["a", "b"], {}, 1)).toThrow("unexpected argument 'b'");
    expect(() => count(parseFlags(["-n", "0"], { tail: { type: "string", short: "n" } }), "tail", 1)).toThrow(/positive/);
  });
});

describe("toml edits", () => {
  const base = '# my config\nsystem = "work" # me\n\n[profiles.work]\ncolor = 25 # blue-ish\n\n[[projects]]\npath = "~/a"\nprofile = "work"\n';

  it("keeps comments while setting, adding and removing", () => {
    expect(setValue(base, undefined, "default", "work")).toContain('system = "work" # me\ndefault = "work"\n\n[profiles.work]');
    expect(setValue(base, "profiles.work", "color", "blue")).toContain('[profiles.work]\ncolor = "blue"\n');
    expect(setValue(base, "mcpd", "port", 5000).endsWith('profile = "work"\n\n[mcpd]\nport = 5000\n')).toBe(true);
    expect(removeValue(base, undefined, "system")).toBe(base.replace('system = "work" # me\n', ""));
    expect(ensureTable(base, "profiles.work")).toBe(base);
    expect(removeTable(base, "profiles.work")).not.toContain("[profiles.work]");
    expect(removeTable(base, "profiles.work")).toContain("# my config");
    const two = addArrayTable(base, "projects", { path: "~/b", profile: "personal" });
    expect(two.endsWith('[[projects]]\npath = "~/b"\nprofile = "personal"\n')).toBe(true);
    const r = removeArrayTables(two, "projects", (e) => e.profile === "work");
    expect(r.removed).toBe(1);
    expect(r.text).not.toContain('"~/a"');
    expect(r.text).toContain('"~/b"');
  });
});

describe("journal and undo", () => {
  it("restores changed files, deletes created ones, skips files changed since, and can redo", async () => {
    const a = sb.write("a.txt", "old a\n");
    const b = join(sb.home, "b.txt");
    const j = new Journal(sb.env, "test change");
    j.write(a, "new a\n");
    j.write(b, "new b\n");
    expect(j.hint()).toBe(`undo with: turno undo ${j.stamp}`);

    const io = fakeIo(sb.env);
    await undo.run(["--list"], io);
    expect(io.lines[0]).toContain("test change  (2 files)");

    const undone = fakeIo(sb.env);
    expect(await undo.run(["last"], undone)).toBe(0);
    expect(readFileSync(a, "utf8")).toBe("old a\n");
    expect(existsSync(b)).toBe(false);
    const redo = undone.lines.find((l) => l.startsWith("redo with:"))!.split(" ").pop()!;
    expect(await undo.run([redo], fakeIo(sb.env))).toBe(0);
    expect(readFileSync(a, "utf8")).toBe("new a\n");
    expect(readFileSync(b, "utf8")).toBe("new b\n");

    // A file that changed after the journaled command is left alone unless --force.
    const j2 = new Journal(sb.env, "second");
    j2.write(a, "second a\n");
    writeFileSync(a, "edited by hand\n");
    const info = listJournals(sb.env).find((x) => x.stamp === j2.stamp)!;
    expect(undoJournal(info, sb.env).steps[0]!.action).toBe("skip");
    expect(readFileSync(a, "utf8")).toBe("edited by hand\n");
    expect(undoJournal(info, sb.env, { force: true }).steps[0]!.action).toBe("restore");
    expect(readFileSync(a, "utf8")).toBe("new a\n");
  });

  it("records nothing on a dry run", () => {
    const j = new Journal(sb.env, "dry", true);
    j.write(join(sb.home, "c.txt"), "x");
    expect(existsSync(join(sb.home, "c.txt"))).toBe(false);
    expect(listJournals(sb.env)).toEqual([]);
  });
});

describe("profile", () => {
  it("add declares the profile and sets it up; assign, unassign and remove edit config.toml in place", async () => {
    sb.write(".config/turno/config.toml", '# mine\ndefault = "work"\n');
    const io = fakeIo(sb.env);
    expect(await profile.run(["add", "lab", "--color", "green", "--browser", "default"], io)).toBe(0);
    expect(cfg()).toBe('# mine\ndefault = "work"\n\n[profiles.lab]\ncolor = "green"\nbrowser = "default"\n');
    expect(existsSync(join(sb.home, ".local/bin/claude-lab"))).toBe(true);
    expect(io.lines.some((l) => l.startsWith("undo with: turno undo "))).toBe(true);

    const dir = join(sb.home, "code/x");
    mkdirSync(dir, { recursive: true });
    await profile.run(["assign", dir, "lab"], fakeIo(sb.env));
    expect(loadConfig(sb.env).projects).toEqual([{ path: dir, profile: "lab" }]);
    await profile.run(["assign", dir, "work"], fakeIo(sb.env));
    expect(loadConfig(sb.env).projects).toEqual([{ path: dir, profile: "work" }]);
    expect(cfg()).toContain('path = "~/code/x"');

    const which = fakeIo(sb.env);
    await profile.run(["which", dir, "--json"], which);
    expect(JSON.parse(which.lines.join("\n")).assigned).toBe("work");

    expect(await profile.run(["unassign", dir], fakeIo(sb.env))).toBe(0);
    expect(loadConfig(sb.env).projects).toEqual([]);

    await expect(profile.run(["remove", "work"], fakeIo(sb.env))).rejects.toThrow(/default profile/);
    expect(await profile.run(["remove", "lab"], fakeIo(sb.env))).toBe(0);
    expect(cfg()).not.toContain("lab");
    expect(existsSync(join(sb.home, ".local/bin/claude-lab"))).toBe(false);
    expect(existsSync(join(sb.home, ".claude-lab"))).toBe(true);
  });

  it("rejects bad names and colors, and leaves config.toml to migrate", async () => {
    await expect(profile.run(["add", "ui"], fakeIo(sb.env))).rejects.toThrow(/reserved/);
    await expect(profile.run(["add", "lab", "--color", "chartreuse"], fakeIo(sb.env))).rejects.toThrow(/--color/);
    sb.write(".config/claudio/proyectos", "work ~/code\n");
    await expect(profile.run(["add", "lab"], fakeIo(sb.env))).rejects.toThrow(/turno migrate first/);
    expect(existsSync(join(sb.home, ".config/turno/config.toml"))).toBe(false);
  });

  it("lists profiles as JSON", async () => {
    const io = fakeIo(sb.env);
    await profile.run(["--json"], io);
    expect(JSON.parse(io.lines.join("\n")).map((p: { name: string }) => p.name)).toEqual(["personal", "work"]);
  });
});

describe("config", () => {
  it("gets, sets and unsets keys, refusing values the file cannot hold", async () => {
    sb.write(".config/turno/config.toml", '# keep me\nsystem = "work"\n');
    await config.run(["set", "mcpd.port", "5000"], fakeIo(sb.env));
    await config.run(["set", "nerd_terminals", '["warp", "vscode"]'], fakeIo(sb.env));
    await config.run(["set", "profiles.work.color", "violet"], fakeIo(sb.env));
    expect(cfg()).toContain("# keep me");
    expect(loadConfig(sb.env).mcpd.port).toBe(5000);
    expect(loadConfig(sb.env).nerdTerminals).toEqual(["warp", "vscode"]);
    const get = fakeIo(sb.env);
    await config.run(["get", "profiles.work.color"], get);
    expect(get.lines).toEqual(["violet"]);
    await expect(config.run(["set", "mcpd.port", "80"], fakeIo(sb.env))).rejects.toThrow(/mcpd.port/);
    await expect(config.run(["set", "nope", "1"], fakeIo(sb.env))).rejects.toThrow(/unknown key/);
    expect(loadConfig(sb.env).mcpd.port).toBe(5000);
    await config.run(["unset", "system"], fakeIo(sb.env));
    expect(loadConfig(sb.env).system).toBeUndefined();
    expect(parseValue("true")).toBe(true);
    expect(parseValue("work")).toBe("work");
  });

  it("check reports every config file", async () => {
    sb.write(".config/turno/mcp.toml", "[server.x\n");
    const io = fakeIo(sb.env);
    expect(await config.run(["check"], io)).toBe(1);
    expect(io.lines.some((l) => l.startsWith("FAIL"))).toBe(true);
  });
});

describe("limit and old names", () => {
  it("marks exhausted with --until, --for, and the bash form, through every name", async () => {
    expect(parseDuration("2h30m")).toBe(9000);
    expect(parseDuration("x")).toBeUndefined();
    const io = fakeIo(sb.env);
    expect(await main(["limit", "set", "work", "--for", "2h"], io)).toBe(0);
    expect(io.lines[0]).toMatch(/^work exhausted until/);
    expect(existsSync(join(sb.home, ".local/state/turno/exhausted/work"))).toBe(true);
    expect(await main(["available", "work"], fakeIo(sb.env))).toBe(0);
    expect(existsSync(join(sb.home, ".local/state/turno/exhausted/work"))).toBe(false);
    expect(await main(["exhausted", "work", "until", "2099-01-02 03:04"], fakeIo(sb.env))).toBe(0);
    expect(readFileSync(join(sb.home, ".local/state/turno/exhausted/work"), "utf8").trim()).toBe(String(new Date(2099, 0, 2, 3, 4).getTime() / 1000));
    expect(await main(["agotada", "work", "hasta", "2099-01-02 03:05"], fakeIo(sb.env))).toBe(0);
    expect(await main(["disponible", "work"], fakeIo(sb.env))).toBe(0);
    const err = fakeIo(sb.env);
    expect(await main(["limit", "set", "nobody"], err)).toBe(2);
    expect(err.errors[0]).toContain("no profile 'nobody'");
  });

  it("help lists sections and groups answer --help", async () => {
    const io = fakeIo(sb.env);
    await main(["--help"], io);
    const out = io.lines.join("\n");
    expect(out).toContain("Accounts:");
    expect(out).toMatch(/turno profile +Claude Code accounts/);
    expect(out).not.toMatch(/turno exhausted/);
    const g = fakeIo(sb.env);
    await main(["profile", "--help"], g);
    expect(g.lines.join("\n")).toContain("turno profile assign <dir> <profile>");
  });
});

describe("completion", () => {
  it("completes commands, subcommands, profiles, flags and flag values", async () => {
    expect(await complete(["pro"], sb.env)).toEqual(["profile"]);
    expect(await complete(["w"], sb.env)).toEqual(["work"]);
    expect(await complete(["limit", ""], sb.env)).toEqual(["show", "set", "clear"]);
    expect(await complete(["limit", "set", ""], sb.env)).toEqual(["personal", "work"]);
    expect(await complete(["exhausted", "p"], sb.env)).toEqual(["personal"]);
    expect(await complete(["profile", "add", "lab", "--c"], sb.env)).toEqual(["--color"]);
    expect(await complete(["profile", "add", "lab", "--browser", ""], sb.env)).toEqual(["chrome", "default"]);
    expect(await complete(["profile", "assign", ""], sb.env)).toEqual([":dir"]);
    expect(await complete(["run", ""], sb.env)).toEqual(["personal", "work", "auto"]);
    expect(await complete(["config", "set", "profiles.w"], sb.env)).toEqual(["profiles.work.color", "profiles.work.browser"]);
    expect(await complete(["work", ""], sb.env)).toEqual([]);
    for (const s of Object.values(SCRIPTS)) expect(s).toContain("turno __complete --");
  });
});

describe("versions and upgrades", () => {
  it("compares versions and picks the upgrade command for each install", () => {
    expect(compareVersions("0.2.0", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc.2")).toBe(1);
    expect(compareVersions("1.0.0-rc.10", "1.0.0-rc.2")).toBe(1);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(detectInstall("/opt/homebrew/lib/node_modules/@x/turno").method).toBe("npm");
    expect(detectInstall("/Users/a/Library/pnpm/global/5/.pnpm/x@1/node_modules/x").method).toBe("pnpm");
    expect(detectInstall("/Users/a/.bun/install/global/node_modules/x").method).toBe("bun");
    expect(detectInstall(packageInfo().root).method).toBe("source");
    expect(upgradeCommand({ method: "npm", root: "/x" }, "@x/turno", "1.2.3")).toEqual([["npm", "install", "--global", "@x/turno@1.2.3"]]);
    expect(upgradeCommand({ method: "source", root: "/r/p", repo: "/r" }, "turno", "latest")![0]).toEqual(["git", "-C", "/r", "pull", "--ff-only"]);
    expect(registryUrl({}, "@x/turno", "latest")).toBe("https://registry.npmjs.org/@x%2Fturno/latest");
  });

  it("checks the registry, caches the answer and mentions a newer version once a day", async () => {
    expect(updateChecksOff(sb.env)).toBeDefined(); // sandbox and private package
    const env = { ...sb.env, TURNO_NO_UPDATE_CHECK: "" };
    const fake = (async () => new Response(JSON.stringify({ version: "99.0.0" }), { status: 200 })) as unknown as typeof fetch;
    const s = await fetchLatest(env, "latest", fake);
    expect(s.latest).toBe("99.0.0");
    if (!packageInfo().private) {
      expect(updateNotice(env, true, "")).toContain("turno 99.0.0 is available");
      expect(updateNotice(env, true, "")).toBeUndefined();
    } else expect(updateNotice(env, true, "")).toBeUndefined();
  });

  it("finishes an upgrade: rewrites launchers, records the version, shows the changes", () => {
    sb.write(".local/state/turno/version", "0.0.1\n");
    writeFileSync(join(sb.home, ".local/bin/claude-work"), "#!/bin/sh\n# Generated by turno: old\nexec claude\n");
    const io = fakeIo(sb.env);
    expect(finishUpgrade(io)).toBe(0);
    expect(recordedVersion(sb.env)).toBe(packageInfo().version);
    expect(readFileSync(join(sb.home, ".local/bin/claude-work"), "utf8")).toContain("CLAUDE_CONFIG_DIR");
    expect(io.lines).toContain(`turno 0.0.1 -> ${packageInfo().version}`);
    const log = "# Changelog\n\n## 0.3.0\n\n- three\n\n## 0.2.0\n\n- two\n\n## 0.1.0\n\n- one\n";
    expect(changesSince("0.1.0", log, "0.2.0")).toBe("## 0.2.0\n\n- two");
  });

  it("doctor asks to finish an upgrade, and --fix does it; --json is machine readable", async () => {
    sb.write(".local/state/turno/version", "0.0.1\n");
    const io = fakeIo(sb.env);
    await doctor(io, { json: true });
    const data = JSON.parse(io.lines.join("\n"));
    const check = data.checks.find((c: { area: string; level: string }) => c.area === "turno" && c.level === "warn");
    expect(check.fix).toBe("turno upgrade --finish");
    await doctor(fakeIo(sb.env), { fix: true });
    expect(recordedVersion(sb.env)).toBe(packageInfo().version);
  });
});

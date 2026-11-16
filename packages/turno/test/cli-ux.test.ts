import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planAuto } from "../src/cli/commands/auto.js";
import { complete } from "../src/cli/commands/complete.js";
import { collectChecks } from "../src/cli/commands/doctor.js";
import { pathAdvice } from "../src/cli/commands/profile.js";
import { statusData } from "../src/cli/commands/status.js";
import { statusLineInfo } from "../src/cli/commands/ui.js";
import { CliError, type Io, UsageError, closest, columns } from "../src/cli/io.js";
import { launchProfile } from "../src/cli/launch.js";
import { NPX_MESSAGE, launcherText, refuseNpx, resolveTurnoCommand, runningFromNpx, writeLauncher } from "../src/cli/launchers.js";
import { main } from "../src/cli/main.js";
import { COMMANDS, SECTIONS } from "../src/cli/registry.js";
import { ConfigError, loadConfig, parseConfig } from "../src/core/config.js";
import { configProblems } from "../src/core/profiles.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
let acme: string;
const bin = () => join(sb.home, ".local/bin");
const cfgFile = () => join(sb.home, ".config/turno/config.toml");

beforeEach(() => {
  sb = sandbox();
  // A PATH under our control: the fake agents, the launchers' folder, and the system tools.
  sb.env.PATH = `${join(sb.home, ".local/bin")}:/usr/bin:/bin`;
  sb.env.SHELL = "/bin/zsh";
  fakeCommand(sb, "claude", `echo '{"loggedIn":false}'`);
  mkdirSync(join(sb.home, ".claude"), { recursive: true });
  for (const name of ["work", "personal"]) {
    mkdirSync(join(sb.home, `.claude-${name}`), { recursive: true });
    writeLauncher(name, sb.env);
  }
  acme = join(sb.home, "code/acme");
  mkdirSync(acme, { recursive: true });
  sb.write(".config/turno/config.toml", '[profiles.work]\n[profiles.personal]\n\n[[projects]]\npath = "~/code/acme"\nprofile = "work"\n');
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

describe("turno auto never falls back in silence (02-H1)", () => {
  it("execs the folder's launcher and says which account", () => {
    const plan = planAuto(["--resume"], fakeIo(sb.env), acme);
    expect(plan.file).toBe(join(bin(), "claude-work"));
    expect(plan.args).toEqual(["--resume"]);
    expect(plan.notice).toBe("turno: account work (project ~/code/acme)");
  });

  it("refuses when the chosen profile's launcher is missing", () => {
    rmSync(join(bin(), "claude-work"));
    expect(() => planAuto([], fakeIo(sb.env), acme)).toThrow(CliError);
    expect(() => planAuto([], fakeIo(sb.env), acme)).toThrow(
      "~/code/acme uses the work profile, but its launcher ~/.local/bin/claude-work is missing. Run: turno profile repair work",
    );
  });

  it("refuses when the rule names a profile that does not exist", () => {
    writeFileSync(cfgFile(), 'default = "nobody"\n');
    expect(() => planAuto([], fakeIo(sb.env), sb.home)).toThrow(/uses the nobody profile \(folder without a rule\), but there is no such profile/);
  });

  it("refuses with the TOML error when config.toml is broken, unless TURNO_ALLOW_PLAIN=1", () => {
    writeFileSync(cfgFile(), 'default = "work\n');
    let err: unknown;
    try {
      planAuto([], fakeIo(sb.env), acme);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(1);
    expect((err as Error).message).toContain("~/.config/turno/config.toml: line 1: a string is not closed");
    expect((err as Error).message).toContain("TURNO_ALLOW_PLAIN=1");
    const plan = planAuto([], fakeIo({ ...sb.env, TURNO_ALLOW_PLAIN: "1" }), acme);
    expect(plan.file).toBe(join(sb.home, "fakebin/claude"));
    expect(plan.always).toBe(true);
    expect(plan.notice).toMatch(/running plain claude \(TURNO_ALLOW_PLAIN=1\)$/);
  });

  it("says what --agent codex does without a codex profile", () => {
    fakeCommand(sb, "codex", "exit 0");
    const plan = planAuto(["--agent", "codex"], fakeIo(sb.env), acme);
    expect(plan.file).toBe(join(sb.home, "fakebin/codex"));
    expect(plan.always).toBe(true);
    expect(plan.notice).toBe("turno: no Codex CLI profile yet, so this runs plain codex with ~/.codex (turno profile add <name> --agent codex)");
    expect(() => planAuto(["--agent", "copilot"], fakeIo(sb.env), acme)).toThrow(/copilot is not installed/);
  });

  it('runs plain claude outside a rule, but not with system = ""', () => {
    expect(planAuto([], fakeIo(sb.env), sb.home).notice).toBe("turno: no rule or default for ~; running plain claude with ~/.claude");
    writeFileSync(cfgFile(), `system = ""\n${readFileSync(cfgFile(), "utf8")}`);
    expect(loadConfig(sb.env).system).toBe("");
    expect(() => planAuto([], fakeIo(sb.env), sb.home)).toThrow(/no default account\. Assign one: turno profile assign ~ <profile>/);
    expect(planAuto([], fakeIo(sb.env), acme).file).toBe(join(bin(), "claude-work"));
  });

  it("turno <profile> explains a declared profile without its launcher", async () => {
    rmSync(join(bin(), "claude-personal"));
    await expect(launchProfile("personal", [], fakeIo(sb.env))).rejects.toThrow(
      "profile personal has no launcher (~/.local/bin/claude-personal is missing). Run: turno profile repair personal",
    );
    const r = await run(["personal"]);
    expect(r.code).toBe(1);
  });
});

describe("profile which and status show every agent", () => {
  it("adds a line per agent with profiles", async () => {
    fakeCommand(sb, "codex", "exit 0");
    writeFileSync(cfgFile(), `${readFileSync(cfgFile(), "utf8")}\n[profiles.cx]\nagent = "codex"\n\n[[projects]]\npath = "~/code/acme"\nprofile = "cx"\n`);
    const w = await run(["profile", "which", acme]);
    expect(w.io.lines).toEqual(["~/code/acme", "  assigned: work (project ~/code/acme)", "  using now: work", "  codex: cx (project ~/code/acme)"]);
    const j = await run(["profile", "which", acme, "--json"]);
    expect(JSON.parse(j.io.lines.join("\n")).agents.codex).toMatchObject({ chosen: "cx", assigned: "cx" });
    const s = await statusData(sb.env, acme);
    expect(s.here.agents.codex).toEqual({ chosen: "cx", text: "cx (project ~/code/acme)" });
    expect((await run(["status"])).io.lines.some((l) => l.startsWith("sessions  0 live sessions"))).toBe(true);
  });
});

describe("config set and config.toml checks (02-H20, 04-H8)", () => {
  it("validates values like profile add, with exit 2", async () => {
    const cases: [string[], string][] = [
      [["config", "set", "default", "nobody"], "turno: no profile 'nobody' (turno profile list)"],
      [["config", "set", "fallback", "ghost"], "turno: no profile 'ghost' (turno profile list)"],
      [["config", "set", "icons", "fancy"], "turno: icons must be auto, nerd or unicode"],
      [["config", "set", "profiles.work.color", "banana"], "turno: profiles.work.color banana: use a number (0-255) or one of"],
      [["config", "set", "profiles.ghost.color", "red"], "turno: no profile 'ghost' (turno profile list)"],
      [["config", "set", "profiles.work.browser", "firefox"], "turno: profiles.work.browser must be chrome or default"],
      [["config", "set", "mcpd.port", "80"], "turno: mcpd.port must be an integer between 1024 and 65535"],
      [["config", "set", "update_check", "maybe"], "turno: update_check must be true or false"],
      [["config", "set", "agents.codex.default", "work"], "turno: work is a Claude Code profile, but agents.codex.default is for Codex CLI"],
      [["config", "set", "nokey", "x"], "turno: unknown key 'nokey' (turno config --help lists them)"],
    ];
    const before = readFileSync(cfgFile(), "utf8");
    for (const [args, message] of cases) {
      const r = await run(args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.io.errors[0], args.join(" ")).toContain(message);
    }
    expect(readFileSync(cfgFile(), "utf8")).toBe(before);
  });

  it("writes valid values; fallback reminds it is opt-in; system may be empty", async () => {
    expect((await run(["config", "set", "default", "personal"])).code).toBe(0);
    const f = await run(["config", "set", "fallback", "personal"]);
    expect(f.io.lines).toContain('fallback is opt-in: read "Vendor terms" in the README before relying on it.');
    expect((await run(["config", "set", "profiles.work.color", "Violet"])).io.lines[0]).toBe('profiles.work.color = "violet"');
    expect((await run(["config", "set", "system", ""])).code).toBe(0);
    expect(loadConfig(sb.env)).toMatchObject({ default: "personal", fallback: "personal", system: "" });
  });

  it("collects unknown keys with suggestions, and names missing profiles", () => {
    const text = 'defualt = "work"\n[profiles.work]\ncolour = "red"\n[[projects]]\npath = "~/x"\nprofile = "ghost"\n';
    const c = parseConfig(text, cfgFile(), sb.env);
    expect(c.warnings).toEqual([
      "unknown key defualt (did you mean default?); turno ignores it",
      "unknown key profiles.work.colour (did you mean profiles.work.color?); turno ignores it",
    ]);
    expect(configProblems(c, sb.env)).toContain("the rule for ~/x uses profile ghost, which does not exist (turno profile list)");
    expect(configProblems(parseConfig('fallback = "nope"\n', "x", sb.env), sb.env)).toEqual(['fallback = "nope", but there is no profile nope (turno profile list)']);
  });

  it("shows TOML errors with ~ and explains an unclosed string", () => {
    expect(() => parseConfig('default = "work\n', cfgFile(), sb.env)).toThrow(ConfigError);
    expect(() => parseConfig('default = "work\n', cfgFile(), sb.env)).toThrow('~/.config/turno/config.toml: line 1: a string is not closed (a " is missing at the end of the value)');
    expect(() => parseConfig("[open]\nchrome_dir = 1\n", cfgFile(), sb.env)).toThrow("~/.config/turno/config.toml: open.chrome_dir must be a string");
    expect(() => parseConfig('open = "x"\n', cfgFile(), sb.env)).toThrow("[open] must be a table");
  });

  it("doctor and config check list the warnings", async () => {
    writeFileSync(cfgFile(), 'icon = "nerd"\n[[projects]]\npath = "~/x"\nprofile = "ghost"\n');
    const checks = await collectChecks(sb.env);
    const warns = checks.filter((c) => c.area === "config" && c.level === "warn").map((c) => c.text);
    expect(warns).toEqual(["unknown key icon (did you mean icons?); turno ignores it", "the rule for ~/x uses profile ghost, which does not exist (turno profile list)"]);
    const r = await run(["config", "check"]);
    expect(r.io.lines).toContain("warn  unknown key icon (did you mean icons?); turno ignores it");
  });
});

describe("typos (02-H7)", () => {
  it("treats an unknown leading flag as an option, not a profile", async () => {
    for (const flag of ["--verison", "-V"]) {
      const r = await run([flag]);
      expect(r.code).toBe(2);
      expect(r.io.errors).toEqual([`turno: unknown option ${flag} (turno --help)`]);
    }
  });

  it("suggests the command a typo is close to, and profile add only otherwise", async () => {
    expect((await run(["stauts"])).io.errors).toEqual(["turno: unknown command 'stauts'. Did you mean 'turno status'?"]);
    expect((await run(["profle", "list"])).io.errors).toEqual(["turno: unknown command 'profle'. Did you mean 'turno profile'?"]);
    expect((await run(["profile", "lst"])).io.errors).toEqual(["turno: unknown profile command 'lst'. Did you mean 'turno profile list'?"]);
    expect((await run(["zebra"])).io.errors).toEqual(["turno: no profile 'zebra' (turno profile list shows them; turno profile add zebra creates it)"]);
    expect(closest("ui", ["run", "ui"])).toBe("ui");
  });
});

/** Commands whose files this change owns; the others are rewritten elsewhere. */
const MINE = ["run", "auto", "profile", "limit", "session", "ui", "status", "doctor", "config", "undo", "version", "completion"];

describe("one help path (02-H8, 02-H9)", () => {
  it("prints the main help within 80 columns, with the new first line and sections", async () => {
    const r = await run(["--help"]);
    const out = r.io.lines.join("\n");
    expect(r.io.lines[0]).toBe("turno: one MCP gateway and per-folder accounts for Claude Code, Codex, Copilot");
    expect(out).toContain("Start here: turno doctor, then turno mcp import and turno profile add <name>.");
    expect(out).toContain("Developer tools:\n  turno browser     developer tool: compare browser engines (needs");
    expect(out).not.toMatch(/migrate|Older names|claudio|Orca/);
    for (const l of r.io.lines) expect(l.length, l).toBeLessThanOrEqual(80);
  });

  it("answers --help, <sub> --help and help <cmd> on stdout with exit 0", async () => {
    const long: string[] = [];
    for (const name of MINE) {
      const { command } = await COMMANDS[name]!();
      const a = await run([name, "--help"]);
      expect(a.code, name).toBe(0);
      expect(a.io.errors, name).toEqual([]);
      expect(a.io.lines.join("\n"), name).toBe(command.usage);
      const b = await run(["help", name]);
      expect(b.io.lines.join("\n"), name).toBe(command.usage);
      for (const l of command.usage.split("\n")) if (l.length > 80) long.push(`${name}: ${l}`);
      for (const sub of Object.keys(command.subcommands ?? {})) {
        const c = await run([name, sub, "--help"]);
        expect(c.code, `${name} ${sub}`).toBe(0);
        expect(c.io.lines[0], `${name} ${sub}`).toBe("Usage:");
        for (const l of c.io.lines) if (l.length > 80) long.push(`${name} ${sub}: ${l}`);
        expect((await run(["help", name, sub])).io.lines).toEqual(c.io.lines);
      }
    }
    expect(long).toEqual([]);
    expect((await run(["ui", "install", "--help"])).io.lines.join("\n")).toContain("--no-statusline    leave Claude Code's settings.json alone");
    expect((await run(["help", "nothing"])).code).toBe(2);
  });

  it("never runs an action for --help anywhere in the arguments", async () => {
    const r = await run(["limit", "set", "work", "--help"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(sb.home, ".local/state/turno/exhausted/work"))).toBe(false);
  });

  it("has empty states", async () => {
    const empty = sandbox();
    try {
      const r = await main(["limit"], fakeIo(empty.env));
      expect(r).toBe(0);
      const io = fakeIo(empty.env);
      await main(["limit"], io);
      expect(io.lines).toEqual(["No profiles yet (turno profile add <name>)."]);
    } finally {
      empty.cleanup();
    }
  });

  it("wraps two columns at 80", () => {
    const text = columns([["turno x", "word ".repeat(30).trim()]], 2, 20);
    for (const l of text.split("\n")) expect(l.length).toBeLessThanOrEqual(80);
    expect(text.split("\n")[1]).toMatch(/^ {11}word/);
  });
});

describe("strict flags on write commands (04-H7)", () => {
  it("rejects --dry-rn instead of writing", async () => {
    const before = readFileSync(cfgFile(), "utf8");
    const cases = [
      ["profile", "add", "lab", "--dry-rn"],
      ["profile", "remove", "work", "--dry-rn"],
      ["profile", "assign", acme, "work", "--dry-rn"],
      ["profile", "unassign", acme, "--dry-rn"],
      ["profile", "repair", "work", "--dry-rn"],
      ["config", "set", "default", "work", "--dry-rn"],
      ["config", "unset", "default", "--dry-rn"],
      ["limit", "set", "work", "--dry-rn"],
      ["limit", "clear", "work", "--dry-rn"],
      ["undo", "last", "--dry-rn"],
      ["migrate", "--dry-rn"],
      ["ui", "install", "--dry-rn"],
      ["session", "handoff", "work", "--frok"],
      ["resolve", acme, "--jsn"],
      ["version", "--jsn"],
    ];
    for (const args of cases) {
      const r = await run(args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.io.errors[0], args.join(" ")).toMatch(/^turno: unknown option --(dry-rn|frok|jsn)$/);
    }
    expect(readFileSync(cfgFile(), "utf8")).toBe(before);
    expect(existsSync(join(sb.home, ".local/state/turno/exhausted/work"))).toBe(false);
  });

  it("completes flags from the same spec", async () => {
    expect(await complete(["profile", "add", "lab", "--y"], sb.env)).toEqual(["--yes"]);
    expect(await complete(["ui", "install", "--no-"], sb.env)).toEqual(["--no-font", "--no-statusline"]);
    expect(await complete(["config", "set", "agents.c"], sb.env)).toEqual(["agents.codex.default", "agents.copilot.default", "agents.cursor.default", "agents.codex.fallback", "agents.copilot.fallback", "agents.cursor.fallback"]);
  });
});

describe("first-run paths (02-H12, 02-H13, 02-H14)", () => {
  it("launchers stop with a clear message when the agent is missing", () => {
    const text = launcherText("work", sb.env, "claude", "darwin");
    expect(text).toContain('command -v claude >/dev/null 2>&1 || { echo "turno: claude is not installed (https://docs.claude.com/claude-code)" >&2; exit 127; }\nexec claude "$@"');
    expect(launcherText("cx", sb.env, "codex", "darwin")).toContain('echo "turno: codex is not installed (npm install --global @openai/codex)" >&2; exit 127;');
  });

  it("exports BROWSER only where turno-open can work", () => {
    expect(launcherText("work", sb.env, "claude", "darwin")).toContain('export BROWSER="$HOME/.local/bin/turno-open"');
    expect(launcherText("work", sb.env, "claude", "win32")).not.toContain("BROWSER");
    // A PATH with no xdg-open at all (CI runners have one in /usr/bin).
    const emptyBin = join(sb.home, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    expect(launcherText("work", { ...sb.env, PATH: emptyBin }, "claude", "linux")).not.toContain("BROWSER");
    fakeCommand(sb, "xdg-open", "exit 0");
    expect(launcherText("work", sb.env, "claude", "linux")).toContain("export BROWSER=");
  });

  it("prefers the turno on PATH, else warns about the absolute path", () => {
    expect(resolveTurnoCommand(sb.env, "/elsewhere/main.js")).toEqual({ words: "turno" });
    const onPath = fakeCommand(sb, "turno", "exit 0");
    expect(resolveTurnoCommand(sb.env)).toEqual({ words: `"${onPath}"` });
    const nvm = join(sb.home, ".nvm/versions/node/v24.0.0/bin");
    mkdirSync(nvm, { recursive: true });
    writeFileSync(join(nvm, "turno"), "#!/bin/sh\n", { mode: 0o755 });
    const r = resolveTurnoCommand({ ...sb.env, PATH: `${nvm}:/usr/bin` });
    expect(r.warning).toBe("wrote an absolute path (~/.nvm/versions/node/v24.0.0/bin/turno); it breaks if you switch Node versions");
    const self = sb.write("repo/dist/cli/main.js", "");
    expect(statusLineInfo({ ...sb.env, PATH: "/usr/bin" }, self).warning).toMatch(/^wrote an absolute path \(~\/repo\/dist\/cli\/main\.js\) because turno is not on your PATH/);
  });

  it("refuses writes that keep a path into npx's cache", () => {
    const npx = sb.write(".npm/_npx/abc/node_modules/turno-cli/dist/cli/main.js", "");
    expect(runningFromNpx(npx)).toBe(true);
    expect(runningFromNpx(join(sb.home, "lib/node_modules/turno-cli/dist/cli/main.js"))).toBe(false);
    expect(() => refuseNpx(npx)).toThrow(NPX_MESSAGE);
  });

  it("warns when ~/.local/bin is not on PATH, with the exact line, and suggests turno <name>", async () => {
    sb.env.PATH = "/usr/bin:/bin";
    fakeCommand(sb, "claude", "exit 0");
    expect(pathAdvice(sb.env)).toBe('Add to ~/.zshrc: export PATH="$HOME/.local/bin:$PATH"');
    expect(pathAdvice({ ...sb.env, SHELL: "/usr/local/bin/fish" })).toBe("Add to ~/.config/fish/config.fish: fish_add_path ~/.local/bin");
    const r = await run(["profile", "add", "lab"]);
    expect(r.code).toBe(0);
    expect(r.io.errors).toContain('warning: ~/.local/bin is not on your PATH, so claude-lab will not be found. Add to ~/.zshrc: export PATH="$HOME/.local/bin:$PATH"');
    expect(r.io.lines).toContain("Next: run turno lab and sign in with /login. turno profile list shows the profile.");
    const checks = await collectChecks(sb.env);
    expect(checks.find((c) => c.text.includes("is not on your PATH"))?.level).toBe("warn");
  });

  it("doctor lists the four agents and fails only for one a profile uses", async () => {
    const checks = (await collectChecks(sb.env)).filter((c) => c.area === "system");
    const by = (cmd: string) => checks.find((c) => c.text.startsWith(`${cmd} `));
    expect(by("claude")?.level).toBe("ok");
    expect(by("codex")).toMatchObject({ level: "info", text: "codex not installed (npm install --global @openai/codex)" });
    expect(by("copilot")?.level).toBe("info");
    expect(by("cursor-agent")?.level).toBe("info");
    writeFileSync(cfgFile(), `${readFileSync(cfgFile(), "utf8")}\n[profiles.cx]\nagent = "codex"\n`);
    const after = (await collectChecks(sb.env)).find((c) => c.text.startsWith("codex "));
    expect(after).toMatchObject({ level: "fail", text: "codex not found on PATH, and profiles use it (npm install --global @openai/codex)" });
  });

  it("profile add --agent warns when the agent is not installed", async () => {
    const r = await run(["profile", "add", "gh", "--agent", "copilot"]);
    expect(r.code).toBe(0);
    expect(r.io.errors).toContain("warning: copilot is not installed yet (npm install --global @github/copilot); the profile works once it is");
  });
});

describe("profile add output and own files (02-H18)", () => {
  beforeEach(() => {
    mkdirSync(join(sb.home, ".claude-old/skills/mine"), { recursive: true });
    writeFileSync(join(sb.home, ".claude-old/skills/mine/SKILL.md"), "mine\n");
    writeFileSync(join(sb.home, ".claude/settings.json"), "{}\n");
    writeFileSync(join(sb.home, ".claude-old/settings.json"), '{"mine":true}\n');
  });

  it("refuses to move your own files without a person or --yes", async () => {
    const r = await run(["profile", "add", "old"]);
    expect(r.code).toBe(1);
    expect(r.io.errors[0]).toBe(
      "turno: ~/.claude-old has its own skills, settings.json. turno moves them to .aside-<time>/ in that folder and links the shared ones instead. Run again with --yes to go ahead.",
    );
    expect(readFileSync(cfgFile(), "utf8")).not.toContain("[profiles.old]");
    expect(readdirSync(join(sb.home, ".claude-old")).some((e) => e.startsWith(".aside-"))).toBe(false);
  });

  it("asks in a terminal: no leaves everything, yes moves and says where", async () => {
    const no = asking("n");
    expect((await run(["profile", "add", "old"], no)).code).toBe(1);
    expect(no.asked).toEqual(["Go ahead? [y/N] "]);
    expect(readFileSync(join(sb.home, ".claude-old/settings.json"), "utf8")).toBe('{"mine":true}\n');
    const yes = asking("y");
    expect((await run(["profile", "add", "old"], yes)).code).toBe(0);
    const aside = readdirSync(join(sb.home, ".claude-old")).find((e) => e.startsWith(".aside-"))!;
    expect(readFileSync(join(sb.home, ".claude-old", aside, "settings.json"), "utf8")).toBe('{"mine":true}\n');
    expect(yes.lines).toContain(`  ! moved your own skills, settings.json to ~/.claude-old/${aside}/ (merge by hand if useful; turno undo does not move them back)`);
  });

  it("prints one line for the shared items, every item with -v", async () => {
    const r = await run(["profile", "add", "old", "--yes"]);
    expect(r.io.lines.filter((l) => l.includes("↔"))).toEqual([]);
    expect(r.io.lines).toContain("▸ old → ~/.claude-old: shares 23 items with ~/.claude (-v lists them)");
    const v = await run(["profile", "repair", "old", "-v"]);
    expect(v.io.lines.filter((l) => /^ {2}[=↔] /.test(l))).toHaveLength(23);
  });
});

describe("registry", () => {
  it("hides migrate but keeps it working", async () => {
    expect(SECTIONS.flatMap((s) => s.commands)).not.toContain("migrate");
    const r = await run(["migrate", "--dry-run"]);
    expect(r.code).toBe(0);
  });

  it("main maps CliError and UsageError to their exit codes", () => {
    expect(new CliError("x", 127).code).toBe(127);
    expect(new UsageError("x").name).toBe("UsageError");
  });
});

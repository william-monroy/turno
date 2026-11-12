import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor } from "../src/cli/commands/doctor.js";
import { command as open, isClaudeUrl, openArgs } from "../src/cli/commands/open.js";
import { command as status } from "../src/cli/commands/status.js";
import { command as usage, usageSnapshot } from "../src/cli/commands/usage.js";
import { writeLauncher } from "../src/cli/launchers.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
const AUTH = `case "$CLAUDE_CONFIG_DIR" in
  */.claude-work) echo '{"loggedIn":true,"email":"alice@example.com","orgName":"Acme","subscriptionType":"max","authMethod":"claude.ai"}' ;;
  *) echo '{"loggedIn":false}' ;;
esac`;

beforeEach(() => {
  sb = sandbox();
  for (const name of ["work", "personal"]) {
    mkdirSync(join(sb.home, `.claude-${name}`), { recursive: true });
    writeLauncher(name, sb.env);
  }
  fakeCommand(sb, "claude", AUTH);
});
afterEach(() => sb.cleanup());

describe("usage", () => {
  it("shows the account, bars and reset times, and records the plan", async () => {
    const now = Math.floor(Date.now() / 1000);
    sb.write(
      ".local/state/claudio/usage/work.json",
      JSON.stringify({ updated_at: now - 120, rate_limits: { five_hour: { used_percentage: 62, resets_at: now + 3700 }, seven_day: { used_percentage: 10, resets_at: now + 3 * 86400 } } }),
    );
    const io = fakeIo(sb.env);
    expect(await usage.run([], io)).toBe(0);
    const text = io.lines.join("\n");
    expect(text).toContain("work  alice@example.com · max");
    expect(text).toMatch(/ {2}5 hours █{19}░{11}  62% {2}resets in 1h01m \(/);
    expect(text).toMatch(/ {2}week {4}█{3}░{27}  10% {2}resets in 2d 23h/);
    expect(text).toContain("  data from 2 min ago");
    expect(text).toContain("personal  not logged in");
    expect(text).toContain("  no data yet: shows up once a session of this account gets a response");
    expect(readFileSync(join(sb.home, ".local/state/claudio/plan/work"), "utf8")).toBe("max\n");
  });

  it("prefers the newer of the state and legacy snapshots", () => {
    sb.write(".local/state/claudio/usage/work.json", JSON.stringify({ updated_at: 100, rate_limits: { five_hour: { used_percentage: 1 } } }));
    sb.write(".config/claudio/uso/work.json", JSON.stringify({ updated_at: 200, rate_limits: { five_hour: { used_percentage: 2 } } }));
    expect(usageSnapshot("work", sb.env).updated_at).toBe(200);
    sb.write(".local/state/claudio/usage/work.json", JSON.stringify({ updated_at: 300 }));
    expect(usageSnapshot("work", sb.env).updated_at).toBe(300);
  });
});

describe("status", () => {
  it("shows this folder, each profile with its usage, sessions, mcpd and the look", async () => {
    sb.write(".local/state/claudio/usage/work.json", JSON.stringify({ updated_at: 100, rate_limits: { five_hour: { used_percentage: 42 } } }));
    const io = fakeIo(sb.env);
    expect(await status.run([], io)).toBe(0);
    const out = io.lines.join("\n");
    expect(out).toMatch(/^claudio \d+\.\d+\.\d+/);
    expect(out).toMatch(/profiles +personal/);
    expect(out).toMatch(/work +5h .* 42%/);
    expect(out).toContain("alice@example.com · max");
    expect(out).toContain("mcpd      not running");
    const json = fakeIo(sb.env);
    await status.run(["--json"], json);
    const data = JSON.parse(json.lines.join("\n"));
    expect(data.profiles.find((p: { name: string }) => p.name === "work").fiveHour.used).toBe(42);
  });
});

describe("doctor shared links", () => {
  it("reports local copies, missing links and unclassified items, and --fix relinks them", async () => {
    mkdirSync(join(sb.home, ".claude/projects"), { recursive: true });
    sb.write(".claude/CLAUDE.md", "x\n");
    symlinkSync(join(sb.home, ".claude/projects"), join(sb.home, ".claude-work/projects"));
    sb.write(".claude-work/skills/local.md", "x\n");
    sb.write(".claude-work/history.jsonl", "");
    sb.write(".claude-work/mystery", "");
    const io = fakeIo(sb.env);
    await doctor(io);
    expect(io.lines).toEqual(
      expect.arrayContaining([
        "warn  profile work: skills is a local copy, not shared  [fix: claudio profile repair work]",
        "warn  profile work: missing link for CLAUDE.md  [fix: claudio profile repair work]",
        "info  profile work: mystery is new and unclassified: decide whether to share it",
      ]),
    );
    expect(io.lines.some((l) => l.includes("history.jsonl"))).toBe(false);
    const fixed = fakeIo(sb.env);
    await doctor(fixed, { fix: true });
    expect(fixed.lines).toContain("$ claudio profile repair work");
    expect(fixed.lines.some((l) => l.includes("skills is a local copy"))).toBe(false);
  });
});

describe("open", () => {
  beforeEach(() => {
    mkdirSync(join(sb.home, "Chrome.app"));
    sb.env.CLAUDIO_CHROME_APP = join(sb.home, "Chrome.app");
    sb.write(".config/claudio/config.toml", 'system = "personal"\n[profiles.personal]\nbrowser = "default"\n');
  });

  it("matches only claude.ai and claude.com links", () => {
    expect(isClaudeUrl("https://claude.ai/artifact/x")).toBe(true);
    expect(isClaudeUrl("https://www.claude.com/x")).toBe(true);
    expect(isClaudeUrl("https://example.com/claude.ai/")).toBe(false);
    expect(isClaudeUrl("http://claude.ai/x")).toBe(false);
  });

  it("picks the Chrome profile from the argument or CLAUDE_CONFIG_DIR", () => {
    const chrome = join(sb.home, ".local/share/claudio/chrome");
    const url = "https://claude.ai/artifact/1";
    expect(openArgs("work", url, sb.env)).toEqual(["-na", "Google Chrome", "--args", `--user-data-dir=${chrome}`, "--profile-directory=work", url]);
    expect(openArgs(undefined, url, { ...sb.env, CLAUDE_CONFIG_DIR: join(sb.home, ".claude-work") })).toContain("--profile-directory=work");
    expect(openArgs(undefined, url, sb.env)).toEqual([url]); // system profile uses the default browser
    expect(openArgs("work", "https://example.com", sb.env)).toEqual(["https://example.com"]);
    expect(() => openArgs("setup", url, sb.env)).toThrow(/reserved/);
  });

  it("runs open with those arguments", async () => {
    const log = join(sb.home, "open.log");
    fakeCommand(sb, "open", `printf '%s\\n' "$@" > "${log}"`);
    expect(await open.run(["work", "https://claude.ai/x"], fakeIo(sb.env))).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("--profile-directory=work\nhttps://claude.ai/x\n");
  });
});

describe("doctor", () => {
  it("passes with claude on PATH and generated launchers", async () => {
    const io = fakeIo(sb.env);
    expect(await doctor(io)).toBe(0);
    expect(io.lines.some((l) => /^ok {4}profile work: launcher ok$/.test(l))).toBe(true);
    expect(io.lines.some((l) => l.includes("mcpd: no token"))).toBe(true);
  });

  it("fails on a broken config or a foreign launcher", async () => {
    sb.write(".config/claudio/config.toml", "system = [");
    const io = fakeIo(sb.env);
    expect(await doctor(io)).toBe(1);
    sb.write(".config/claudio/config.toml", "");
    sb.write(".local/bin/claude-work", "#!/bin/sh\nexec claude\n", 0o755);
    const io2 = fakeIo(sb.env);
    expect(await doctor(io2)).toBe(1);
    expect(io2.lines.some((l) => l.includes("was not generated by claudio"))).toBe(true);
  });
});

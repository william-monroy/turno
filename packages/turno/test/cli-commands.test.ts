import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor } from "../src/cli/commands/doctor.js";
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
      ".local/state/turno/usage/work.json",
      JSON.stringify({
        updated_at: now - 120,
        rate_limits: {
          five_hour: { used_percentage: 62, resets_at: now + 3700 },
          seven_day: { used_percentage: 10, resets_at: now + 3 * 86400 },
        },
      }),
    );
    const io = fakeIo(sb.env);
    expect(await usage.run([], io)).toBe(0);
    const text = io.lines.join("\n");
    expect(text).toContain("work  alice@example.com · max");
    expect(text).toMatch(/^ {2}5 hours {2}█{12}░{8} {2}62% {2}resets in 1h01m \(/m);
    expect(text).toMatch(/^ {2}week {5}█{2}░{18} {2}10% {2}resets in 2d 23h/m);
    expect(text).toContain("  data from 2 min ago");
    expect(text).toContain("personal  not logged in");
    expect(text).toContain("  no usage data yet: shows up once a session of this account gets a response");
    expect(readFileSync(join(sb.home, ".local/state/turno/plan/work"), "utf8")).toBe("max\n");
  });

  it("prefers the newer of the state and legacy snapshots", () => {
    sb.write(
      ".local/state/turno/usage/work.json",
      JSON.stringify({ updated_at: 100, rate_limits: { five_hour: { used_percentage: 1 } } }),
    );
    sb.write(
      ".config/claudio/uso/work.json",
      JSON.stringify({ updated_at: 200, rate_limits: { five_hour: { used_percentage: 2 } } }),
    );
    expect(usageSnapshot("work", sb.env).updated_at).toBe(200);
    sb.write(".local/state/turno/usage/work.json", JSON.stringify({ updated_at: 300 }));
    expect(usageSnapshot("work", sb.env).updated_at).toBe(300);
  });
});

describe("status", () => {
  it("shows this folder, each profile with its usage, sessions, mcpd and the look", async () => {
    sb.write(
      ".local/state/turno/usage/work.json",
      JSON.stringify({ updated_at: 100, rate_limits: { five_hour: { used_percentage: 42 } } }),
    );
    const io = fakeIo(sb.env);
    expect(await status.run([], io)).toBe(0);
    const out = io.lines.join("\n");
    expect(out).toMatch(/^turno \d+\.\d+\.\d+/);
    expect(out).toMatch(/^Profiles\n.*5 hours.*week.*account\n {2}personal /m);
    expect(out).toMatch(/^ {2}work +█{3}░{5} +42% /m);
    expect(out).toContain("alice@example.com · max");
    expect(out).toMatch(/^ {2}gateway +not running \(turno mcp daemon start\)$/m);
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
    const out = io.lines.join("\n");
    // One fix line after the run of rows it repairs; plain text names the profile on every row.
    expect(out).toMatch(
      new RegExp(
        [
          "^ {2}! {2}work +skills is a local copy, not shared",
          " {2}! {2}work +missing link for CLAUDE\\.md",
          " {5}fix: turno profile repair work \\(turno doctor --fix runs it\\)",
          " {2}- {2}work +mystery is new and unclassified: decide whether to share it$",
        ].join("\n"),
        "m",
      ),
    );
    expect(out).toMatch(/^\d+ ok, \d+ warnings?, \d+ skipped in \d/m);
    expect(out).toMatch(/^Next {2}turno doctor --fix {2}repairs /m);
    expect(io.lines.some((l) => l.includes("history.jsonl"))).toBe(false);
    const fixed = fakeIo(sb.env);
    await doctor(fixed, { fix: true });
    expect(fixed.lines).toContain("$ turno profile repair work");
    expect(fixed.lines.some((l) => l.includes("skills is a local copy"))).toBe(false);
  });
});

describe("doctor", () => {
  it("passes with claude on PATH and generated launchers", async () => {
    const io = fakeIo(sb.env);
    expect(await doctor(io)).toBe(0);
    expect(io.lines.some((l) => /^ {2}ok work +launcher ok$/.test(l))).toBe(true);
    expect(io.lines.some((l) => l.includes("mcpd: no token"))).toBe(true);
  });

  it("fails on a broken config or a foreign launcher", async () => {
    sb.write(".config/turno/config.toml", "system = [");
    const io = fakeIo(sb.env);
    expect(await doctor(io)).toBe(1);
    sb.write(".config/turno/config.toml", "");
    sb.write(".local/bin/claude-work", "#!/bin/sh\nexec claude\n", 0o755);
    const io2 = fakeIo(sb.env);
    expect(await doctor(io2)).toBe(1);
    expect(io2.lines.some((l) => l.includes("was not generated by turno"))).toBe(true);
  });
});

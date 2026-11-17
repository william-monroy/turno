import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageError } from "../src/cli/io.js";
import { SHARED_DIRS } from "../src/agents/claude.js";
import { setupProfiles } from "../src/cli/commands/setup.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  mkdirSync(join(sb.home, ".claude"));
});
afterEach(() => sb.cleanup());

describe("setup", () => {
  it("creates the hub on a machine where Claude Code never ran", () => {
    rmSync(join(sb.home, ".claude"), { recursive: true });
    const io = fakeIo(sb.env);
    setupProfiles(["work"], io, { turno: "turno" });
    expect(statSync(join(sb.home, ".claude")).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(sb.home, ".claude-work/projects")).isSymbolicLink()).toBe(true);
    expect(io.lines.some((l) => l.includes("created ~/.claude"))).toBe(true);
  });

  it("links the hub, moves local copies aside, seeds config and history, writes launchers", () => {
    sb.write(".claude/CLAUDE.md", "# shared\n");
    sb.write(".claude/settings.json", "{}\n");
    sb.write(".claude/history.jsonl", '{"display":"hi"}\n');
    sb.write(
      ".claude.json",
      JSON.stringify({ mcpServers: { a: {}, b: {} }, projects: { "/x": {} }, oauthAccount: { emailAddress: "alice@example.com" }, theme: "dark" }),
    );
    sb.write(".claude-work/skills/mine/SKILL.md", "local skill\n");
    mkdirSync(join(sb.home, ".claude-work/plans"), { recursive: true });

    const io = fakeIo(sb.env);
    setupProfiles(["work"], io, { turno: "turno" });
    const dir = join(sb.home, ".claude-work");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const item of [...SHARED_DIRS, "CLAUDE.md", "settings.json"]) {
      expect(lstatSync(join(dir, item)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(dir, item))).toBe(join(sb.home, ".claude", item));
    }
    expect(existsSync(join(dir, "keybindings.json"))).toBe(false);

    const aside = readdirSync(dir).filter((e) => e.startsWith(".aside-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]!, "skills/mine/SKILL.md"), "utf8")).toBe("local skill\n");
    expect(io.lines.some((l) => l.includes("moved your own skills to ~/.claude-work/.aside-"))).toBe(true);

    const seeded = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
    expect(Object.keys(seeded).sort()).toEqual(["mcpServers", "projects", "theme"]);
    expect(statSync(join(dir, ".claude.json")).mode & 0o777).toBe(0o600);
    expect(io.lines).toContain("  + .claude.json with 2 MCP servers and 1 project from the hub");

    expect(lstatSync(join(dir, "history.jsonl")).isFile()).toBe(true);
    expect(readFileSync(join(dir, "history.jsonl"), "utf8")).toContain("hi");

    for (const f of ["claude-work", "turno-auto", "turno-open"]) expect(existsSync(join(sb.home, ".local/bin", f))).toBe(true);
  });

  it("is idempotent", () => {
    sb.write(".claude.json", "{}");
    setupProfiles(["work"], fakeIo(sb.env), { turno: "turno" });
    const io = fakeIo(sb.env);
    setupProfiles(["work"], io, { turno: "turno" });
    expect(io.lines.some((l) => l.includes("↔") || l.includes("moved your own"))).toBe(false);
    expect(io.lines).toContain("  = .claude.json already exists (turno mcp sync brings in new MCP servers)");
  });

  it("rejects reserved and invalid names before touching anything", () => {
    expect(() => setupProfiles(["work", "uso"], fakeIo(sb.env))).toThrow(/reserved/);
    expect(() => setupProfiles(["Bad"], fakeIo(sb.env))).toThrow(UsageError);
    expect(existsSync(join(sb.home, ".claude-work"))).toBe(false);
  });

  it("skips replacing a local sessions folder while the profile is busy", () => {
    sb.write(`.claude-work/sessions/${process.pid}.json`, JSON.stringify({ pid: process.pid }));
    const io = fakeIo(sb.env);
    setupProfiles(["work"], io, { turno: "turno" });
    expect(io.lines.some((l) => l.includes("sessions: this profile has open sessions"))).toBe(true);
    expect(lstatSync(join(sb.home, ".claude-work/sessions")).isDirectory()).toBe(true);
  });
});

import { mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAudit, readAudit } from "../src/accounts/audit.js";
import { formatRegistry, loadRegistry, parseRegistry, preferredFor, saveRegistry } from "../src/accounts/registry.js";
import { command } from "../src/cli/commands/accounts.js";
import type { Io } from "../src/cli/io.js";
import { paths } from "../src/core/paths.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const SAMPLE = `
[account."linear:work"]
service = "linear"
profile = "work"
tools = ["mcp__linear__*"]
description = "Work Linear workspace"

[account."linear:personal"]
profile = "personal"
tools = ["mcp__linear__*"]

[account."gmail:personal"]
service = "gmail"
profile = "personal"
tools = ["mcp__claude_ai_Gmail__*", "mcp__gmail__search"]

[[prefer]]
path = "~/code"
linear = "linear:personal"
gmail = "gmail:personal"

[[prefer]]
path = "~/code/acme"
linear = "linear:work"
`;

function io(): Io & { lines: string[]; errs: string[] } {
  const lines: string[] = [];
  const errs: string[] = [];
  return { out: (l = "") => lines.push(l), err: (l = "") => errs.push(l), env: sb.env, isTty: false, lines, errs };
}

describe("accounts registry", () => {
  it("parses accounts and preferences, expanding ~", () => {
    const reg = parseRegistry(SAMPLE, "x", sb.env);
    expect(Object.keys(reg.accounts).sort()).toEqual(["gmail:personal", "linear:personal", "linear:work"]);
    expect(reg.accounts["linear:work"]).toEqual({
      id: "linear:work",
      service: "linear",
      label: "work",
      profile: "work",
      tools: ["mcp__linear__*"],
      description: "Work Linear workspace",
    });
    expect(reg.accounts["linear:personal"]?.service).toBe("linear");
    expect(reg.prefer).toEqual([
      { path: join(sb.home, "code"), accounts: { linear: "linear:personal", gmail: "gmail:personal" } },
      { path: join(sb.home, "code", "acme"), accounts: { linear: "linear:work" } },
    ]);
  });

  it("treats a missing file as empty", () => {
    expect(loadRegistry(sb.env)).toEqual({ accounts: {}, prefer: [] });
  });

  it.each([
    ['[account."linear"]\nprofile = "work"\ntools = ["x"]', /invalid account id/],
    ['[account."linear:work"]\nprofile = "Work!"\ntools = ["x"]', /invalid profile name/],
    ['[account."linear:work"]\ntools = ["x"]', /needs profile/],
    ['[account."linear:work"]\nprofile = "work"\ntools = []', /non-empty array/],
    ['[account."linear:work"]\nprofile = "work"', /non-empty array/],
    ['[account."linear:work"]\nprofile = "work"\ntools = ["a b"]', /invalid tool pattern/],
    ['[account."linear:work"]\nservice = "gmail"\nprofile = "work"\ntools = ["x"]', /id starts with "linear"/],
    ['[[prefer]]\nlinear = "linear:work"', /needs path/],
    ['[[prefer]]\npath = "~/x"\nlinear = "linear:work"', /unknown account/],
    ['[account."gmail:work"]\nprofile = "work"\ntools = ["x"]\n[[prefer]]\npath = "~/x"\nlinear = "gmail:work"', /belongs to service "gmail"/],
    ["account = [", /accounts.toml|x/],
  ])("rejects %s", (text, err) => {
    expect(() => parseRegistry(text, "x", sb.env)).toThrow(err);
  });

  it("picks the preferred account per service by longest path prefix", () => {
    const reg = parseRegistry(SAMPLE, "x", sb.env);
    const acme = join(sb.home, "code", "acme", "app");
    mkdirSync(acme, { recursive: true });
    expect(preferredFor(reg, acme)).toEqual({ linear: "linear:work", gmail: "gmail:personal" });
    expect(preferredFor(reg, join(sb.home, "code", "other"))).toEqual({ linear: "linear:personal", gmail: "gmail:personal" });
    expect(preferredFor(reg, join(sb.home, "code-old"))).toEqual({});
    expect(preferredFor(reg, sb.home)).toEqual({});
    // Through a symlink into the acme tree.
    symlinkSync(join(sb.home, "code", "acme"), join(sb.home, "acme-link"));
    expect(preferredFor(reg, join(sb.home, "acme-link")).linear).toBe("linear:work");
  });

  it("round-trips through saveRegistry with ~ paths", () => {
    const reg = parseRegistry(SAMPLE, "x", sb.env);
    const file = saveRegistry(reg, sb.env);
    expect(file).toBe(paths(sb.env).accountsFile);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("Comments are not preserved");
    expect(text).toContain('path = "~/code/acme"');
    expect(loadRegistry(sb.env)).toEqual(reg);
    expect(formatRegistry(reg, sb.env)).toBe(text);
  });
});

describe("audit log", () => {
  it("appends JSONL with mode 600 and reads the tail", () => {
    const base = { caller: { profile: "personal", pid: 42 }, owner: "work", write: false, outcome: "ok" as const, detail: "", durationMs: 5, costUsd: 0.01 };
    appendAudit({ ...base, account: "linear:work", task: "x".repeat(800) }, sb.env);
    appendAudit({ ...base, account: "gmail:personal", task: "second", outcome: "refused", detail: "declined" }, sb.env);
    appendAudit({ ...base, account: "linear:work", task: "third", outcome: "error", costUsd: null }, sb.env);
    const file = paths(sb.env).auditLog;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const all = readAudit(0, sb.env);
    expect(all).toHaveLength(3);
    expect(all[0]?.task).toHaveLength(500);
    expect(all[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(readAudit(2, sb.env).map((e) => e.task)).toEqual(["second", "third"]);
    expect(readAudit(2, sb.env)[0]).toMatchObject({ outcome: "refused", detail: "declined", caller: { profile: "personal", pid: 42 } });
  });

  it("returns nothing when there is no log", () => {
    expect(readAudit(10, sb.env)).toEqual([]);
  });
});

describe("claudio accounts", () => {
  it("adds, prefers, lists, removes and shows the log", async () => {
    const t = io();
    expect(await command.run(["add", "linear:work", "--profile", "work", "--tools", "mcp__linear__*,mcp__linear2__*", "--description", "Work Linear"], t)).toBe(0);
    expect(t.errs.join("\n")).toMatch(/no launcher claude-work/);
    expect(await command.run(["add", "gmail:personal", "--profile=personal", "--tools", "mcp__gmail__*"], t)).toBe(0);
    mkdirSync(join(sb.home, "code", "acme"), { recursive: true });
    expect(await command.run(["prefer", "~/code/acme", "linear=linear:work"], t)).toBe(0);
    let reg = loadRegistry(sb.env);
    expect(reg.accounts["linear:work"]?.tools).toEqual(["mcp__linear__*", "mcp__linear2__*"]);
    expect(reg.prefer).toEqual([{ path: join(sb.home, "code", "acme"), accounts: { linear: "linear:work" } }]);

    const l = io();
    await command.run(["list"], l);
    expect(l.lines.join("\n")).toMatch(/linear:work\s+work\s+mcp__linear__\*/);
    expect(l.lines.join("\n")).toContain("~/code/acme  linear=linear:work");

    await expect(command.run(["prefer", "~/code", "linear=gmail:personal"], t)).rejects.toThrow(/belongs to service "gmail"/);
    await expect(command.run(["add", "bad", "--profile", "work", "--tools", "x"], t)).rejects.toThrow(/invalid account id/);
    await expect(command.run(["add", "linear:x", "--tools", "x"], t)).rejects.toThrow(/--profile is required/);

    expect(await command.run(["remove", "linear:work"], t)).toBe(0);
    reg = loadRegistry(sb.env);
    expect(Object.keys(reg.accounts)).toEqual(["gmail:personal"]);
    expect(reg.prefer).toEqual([]);

    appendAudit(
      { caller: { profile: "personal", pid: 7 }, account: "linear:work", owner: "work", write: true, task: "create an issue", outcome: "refused", detail: "the user chose decline", durationMs: 1200, costUsd: null },
      sb.env,
    );
    const lg = io();
    expect(await command.run(["log", "--tail", "5"], lg)).toBe(0);
    expect(lg.lines.join("\n")).toMatch(/refused\s+personal#7 -> linear:work \(work\) write 1s/);
    expect(lg.lines.join("\n")).toContain("the user chose decline");
  });
});

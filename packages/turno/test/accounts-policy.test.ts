import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAudit } from "../src/accounts/audit.js";
import { decide, defaultConfirm, patternCovers } from "../src/accounts/policy.js";
import { formatRegistry, loadRegistry, makeAccount, parseRegistry, saveRegistry } from "../src/accounts/registry.js";
import { command } from "../src/cli/commands/accounts.js";
import type { Io } from "../src/cli/io.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const TEXT = `
[account."linear:work"]
profile = "work"
tools = ["mcp__linear__*"]
read_tools = ["mcp__linear__get_*", "mcp__linear__list_issues"]

[account."gmail:work"]
profile = "work"
tools = ["mcp__claude_ai_Gmail__*"]
read_tools = ["mcp__claude_ai_Gmail__search_threads"]

[account."jira:work"]
profile = "work"
tools = ["mcp__jira__*"]
confirm = "never"
`;

describe("account policy fields", () => {
  it("parses read_tools and confirm, and writes them back", () => {
    const reg = parseRegistry(TEXT, "x", sb.env);
    expect(reg.accounts["linear:work"]).toMatchObject({
      readTools: ["mcp__linear__get_*", "mcp__linear__list_issues"],
    });
    expect(reg.accounts["linear:work"]?.confirm).toBeUndefined();
    expect(reg.accounts["jira:work"]).toMatchObject({ confirm: "never" });
    expect(reg.accounts["jira:work"]?.readTools).toBeUndefined();
    saveRegistry(reg, sb.env);
    expect(loadRegistry(sb.env)).toEqual(reg);
    expect(formatRegistry(reg, sb.env)).toMatch(/read_tools = \[/);
  });

  it("rejects read tools outside the account's tools and unknown policies", () => {
    expect(() =>
      parseRegistry(
        `[account."linear:work"]\nprofile = "work"\ntools = ["mcp__linear__*"]\nread_tools = ["mcp__gmail__send"]\n`,
        "x",
        sb.env,
      ),
    ).toThrow(/read_tools: "mcp__gmail__send" is not covered by the account's tools/);
    expect(() =>
      parseRegistry(
        `[account."linear:work"]\nprofile = "work"\ntools = ["mcp__linear__get_issue"]\nread_tools = ["mcp__linear__*"]\n`,
        "x",
        sb.env,
      ),
    ).toThrow(/not covered/);
    expect(() =>
      parseRegistry(
        `[account."linear:work"]\nprofile = "work"\ntools = ["mcp__linear__*"]\nconfirm = "sometimes"\n`,
        "x",
        sb.env,
      ),
    ).toThrow(/confirm must be "always", "writes" or "never"/);
    expect(() => makeAccount("linear:work", { profile: "work", tools: ["mcp__linear__*"], readTools: [] })).toThrow(
      /read_tools must be a non-empty array/,
    );
  });

  it("matches tool patterns with a trailing star", () => {
    expect(patternCovers("mcp__linear__*", "mcp__linear__get_issue")).toBe(true);
    expect(patternCovers("mcp__linear__*", "mcp__linear__get_*")).toBe(true);
    expect(patternCovers("mcp__linear__get_issue", "mcp__linear__get_issue")).toBe(true);
    expect(patternCovers("mcp__linear__get_issue", "mcp__linear__*")).toBe(false);
    expect(patternCovers("mcp__linear__*", "mcp__linear2__x")).toBe(false);
  });
});

describe("decide", () => {
  const reg = () => parseRegistry(TEXT, "x", sb.env).accounts;

  it("defaults to always for mail and messaging, writes elsewhere", () => {
    expect(defaultConfirm("gmail")).toBe("always");
    expect(defaultConfirm("outlook")).toBe("always");
    expect(defaultConfirm("slack")).toBe("always");
    expect(defaultConfirm("fastmail")).toBe("always");
    expect(defaultConfirm("linear")).toBe("writes");
    expect(defaultConfirm("github")).toBe("writes");
  });

  it("gives a read only the read tools, without confirmation under writes", () => {
    expect(decide(reg()["linear:work"]!, false)).toMatchObject({
      policy: "writes",
      confirm: false,
      toolset: "read",
      tools: ["mcp__linear__get_*", "mcp__linear__list_issues"],
    });
  });

  it("confirms a write and gives it every tool", () => {
    expect(decide(reg()["linear:work"]!, true)).toMatchObject({
      policy: "writes",
      confirm: true,
      toolset: "all",
      tools: ["mcp__linear__*"],
    });
  });

  it("confirms every call on a mail account, reads still limited to the read tools", () => {
    expect(decide(reg()["gmail:work"]!, false)).toMatchObject({
      policy: "always",
      confirm: true,
      toolset: "read",
      tools: ["mcp__claude_ai_Gmail__search_threads"],
    });
    expect(decide(reg()["gmail:work"]!, true)).toMatchObject({ confirm: true, toolset: "all" });
  });

  it("treats a read without read_tools like a write", () => {
    const acct = makeAccount("linear:other", { profile: "work", tools: ["mcp__linear__*"] });
    expect(decide(acct, false)).toMatchObject({
      policy: "writes",
      confirm: true,
      toolset: "all",
      tools: ["mcp__linear__*"],
    });
    expect(decide(acct, false).reason).toMatch(/no read_tools/);
  });

  it("never asks under confirm = never", () => {
    expect(decide(reg()["jira:work"]!, true)).toMatchObject({ policy: "never", confirm: false, toolset: "all" });
    expect(decide(reg()["jira:work"]!, false)).toMatchObject({ policy: "never", confirm: false, toolset: "all" });
  });
});

describe("turno identity add with a policy", () => {
  function io(): Io & { lines: string[]; errs: string[] } {
    const lines: string[] = [];
    const errs: string[] = [];
    return { out: (l = "") => lines.push(l), err: (l = "") => errs.push(l), env: sb.env, isTty: false, lines, errs };
  }

  it("records read tools and the confirm policy, and lists them", async () => {
    const t = io();
    expect(
      await command.run(
        [
          "add",
          "linear:work",
          "--profile",
          "work",
          "--tools",
          "mcp__linear__*",
          "--read-tools",
          "mcp__linear__get_*,mcp__linear__list_issues",
          "--confirm",
          "writes",
        ],
        t,
      ),
    ).toBe(0);
    expect(await command.run(["add", "gmail:work", "--profile", "work", "--tools", "mcp__claude_ai_Gmail__*"], t)).toBe(
      0,
    );
    const reg = loadRegistry(sb.env);
    expect(reg.accounts["linear:work"]).toMatchObject({
      readTools: ["mcp__linear__get_*", "mcp__linear__list_issues"],
      confirm: "writes",
    });
    expect(reg.accounts["gmail:work"]?.confirm).toBeUndefined();
    const l = io();
    await command.run(["list"], l);
    const text = l.lines.join("\n");
    expect(text).toMatch(/linear:work .*\n\s+confirm writes; reads: mcp__linear__get_\*, mcp__linear__list_issues/);
    expect(text).toMatch(/gmail:work .*\n\s+confirm always \(default\); no read_tools: every call is confirmed/);
    await expect(
      command.run(["add", "linear:x", "--profile", "work", "--tools", "mcp__linear__*", "--confirm", "maybe"], t),
    ).rejects.toThrow(/confirm must be/);
    await expect(
      command.run(
        ["add", "linear:x", "--profile", "work", "--tools", "mcp__linear__get_issue", "--read-tools", "mcp__linear__*"],
        t,
      ),
    ).rejects.toThrow(/not covered/);
  });

  it("shows the decision in the log", async () => {
    appendAudit(
      {
        caller: { profile: "personal", pid: 7 },
        account: "linear:work",
        owner: "work",
        write: false,
        task: "read ABC-1",
        outcome: "ok",
        detail: "2 turns; blocked: mcp__linear__create_issue",
        durationMs: 1000,
        costUsd: 0.01,
        decision: {
          policy: "writes",
          asked: false,
          toolset: "read",
          allowed: ["mcp__linear__get_*"],
          mcp: "strict",
          denied: ["mcp__linear__create_issue"],
        },
      },
      sb.env,
    );
    const lg = io();
    expect(await command.run(["log"], lg)).toBe(0);
    const text = lg.lines.join("\n");
    expect(text).toMatch(/ok\s+personal#7 -> linear:work \(work\) read 1s \$0\.0100/);
    expect(text).toMatch(/read tools, not asked, strict MCP; blocked: mcp__linear__create_issue/);
  });
});

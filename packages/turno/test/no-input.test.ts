import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_IDS } from "../src/agents/index.js";
import { AGENT_SESSION_ENV, noInputReason } from "../src/cli/io.js";
import { main, takeNoInput } from "../src/cli/main.js";
import { fakeIo } from "./helpers/cli.js";
import { fakeSecretStore } from "./helpers/fake-secret-store.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

describe("when turno may ask", () => {
  it("asks only without TURNO_NO_INPUT and outside agent sessions", () => {
    expect(noInputReason({})).toBeUndefined();
    expect(noInputReason({ TURNO_NO_INPUT: "1" })).toBe("TURNO_NO_INPUT");
    expect(noInputReason({ TURNO_NO_INPUT: "" })).toBeUndefined();
    const sessions: [string, string][] = [
      ["CLAUDECODE", "1"],
      ["CLAUDE_CODE_CHILD_SESSION", "1"],
      ["CODEX_THREAD_ID", "0199a7c1-0000-7000-8000-000000000000"],
      ["CODEX_SANDBOX", "seatbelt"],
      ["COPILOT_CLI", "1"],
      ["COPILOT_AGENT_SESSION_ID", "s-1"],
      ["CURSOR_AGENT", "1"],
    ];
    for (const [name, value] of sessions) expect(noInputReason({ [name]: value })).toBe(name);
    expect(Object.values(AGENT_SESSION_ENV).flat().sort()).toEqual(sessions.map(([n]) => n).sort());
  });

  it("knows the session variables of every agent turno supports", () => {
    expect(Object.keys(AGENT_SESSION_ENV).sort()).toEqual([...AGENT_IDS].sort());
    for (const names of Object.values(AGENT_SESSION_ENV)) expect(names.length).toBeGreaterThan(0);
  });

  it("ignores an agent variable set to 0 or empty, and TURNO_NO_INPUT=0 wins over an agent", () => {
    expect(noInputReason({ CLAUDECODE: "0", CURSOR_AGENT: "" })).toBeUndefined();
    expect(noInputReason({ CLAUDECODE: "1", TURNO_NO_INPUT: "0" })).toBeUndefined();
    expect(noInputReason({ CLAUDECODE: "1", TURNO_NO_INPUT: "false" })).toBeUndefined();
  });
});

describe("the --no-input flag", () => {
  it("is taken before the command and among a command's own flags", () => {
    expect(takeNoInput(["--no-input", "init", "--yes"])).toEqual({ argv: ["init", "--yes"], noInput: true });
    expect(takeNoInput(["init", "--no-input", "--yes"])).toEqual({ argv: ["init", "--yes"], noInput: true });
    expect(takeNoInput(["mcp", "sync", "--no-input"])).toEqual({ argv: ["mcp", "sync"], noInput: true });
    expect(takeNoInput(["init"])).toEqual({ argv: ["init"], noInput: false });
    expect(takeNoInput(["--no-input"])).toEqual({ argv: [], noInput: true });
  });

  it("leaves what belongs to an agent alone: after --, and the arguments of run and of a profile", () => {
    expect(takeNoInput(["demo", "--", "turno", "init", "--no-input"])).toEqual({
      argv: ["demo", "--", "turno", "init", "--no-input"],
      noInput: false,
    });
    expect(takeNoInput(["run", "work", "--no-input"])).toEqual({ argv: ["run", "work", "--no-input"], noInput: false });
    expect(takeNoInput(["work", "--no-input"])).toEqual({ argv: ["work", "--no-input"], noInput: false });
    expect(takeNoInput(["--no-input", "work", "--no-input"])).toEqual({ argv: ["work", "--no-input"], noInput: true });
  });

  it("is in the help, with TURNO_NO_INPUT", async () => {
    const io = fakeIo(sb.env);
    expect(await main(["--help"], io)).toBe(0);
    expect(io.lines.join("\n")).toMatch(/--no-input or TURNO_NO_INPUT=1 never asks \(exit 2 instead\)/);
  });
});

describe("turno secret set", () => {
  const stdin = process.stdin as { isTTY?: boolean };
  let wasTty: boolean | undefined;
  beforeEach(() => {
    wasTty = stdin.isTTY;
  });
  afterEach(() => {
    stdin.isTTY = wasTty;
  });

  it("never shows the hidden prompt with --no-input or in an agent session, and stores nothing", async () => {
    const store = fakeSecretStore(sb);
    stdin.isTTY = true;
    for (const [args, env] of [
      [["--no-input", "secret", "set", "api"], {}],
      [["secret", "set", "api"], { CODEX_THREAD_ID: "t-1" }],
    ] as const) {
      const io = fakeIo({ ...sb.env, ...env });
      expect(await main([...args], io)).toBe(2);
      expect(io.errors).toEqual([
        "turno: secret set needs an answer; pass the value on stdin (or run it in a terminal)",
      ]);
    }
    expect(store.services()).toEqual([]);
  });
});

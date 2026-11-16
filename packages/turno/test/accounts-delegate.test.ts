import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunSpec, buildDelegation, delegate, launcherExists, parseClaudeJson } from "../src/accounts/delegate.js";
import type { Account } from "../src/accounts/registry.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const WORK: Account = { id: "linear:work", service: "linear", label: "work", profile: "work", tools: ["mcp__linear__*", "mcp__linear2__get_issue"] };

describe("delegation command", () => {
  it("builds the enforced argv, env and cwd", () => {
    const env = { ...sb.env, TURNO_SESSION_PID: "123", KEEP: "1" };
    const dir = join(sb.home, "proj");
    mkdirSync(dir);
    const spec = buildDelegation({ account: WORK, task: "list my open issues", write: false, cwd: dir }, env);
    expect(spec.command).toBe(join(sb.home, ".local", "bin", "claude-work"));
    const a = spec.args;
    expect(a[0]).toBe("-p");
    expect(a[1]).toContain("list my open issues");
    expect(a[1]).toContain("linear:work");
    expect(a[1]).toContain("mcp__linear__*, mcp__linear2__get_issue");
    expect(a[1]).toMatch(/NOT allowed/);
    expect(a.slice(2)).toEqual([
      "--permission-mode",
      "dontAsk",
      "--tools",
      "",
      "--allowedTools",
      "mcp__linear__*",
      "mcp__linear2__get_issue",
      "--disallowedTools",
      "mcp__accounts__*",
      "--output-format",
      "json",
      "--max-turns",
      "15",
    ]);
    expect(spec.cwd).toBe(dir);
    expect(spec.env.TURNO_SESSION_PID).toBeUndefined();
    expect(spec.env.KEEP).toBe("1");
    expect(spec.timeoutMs).toBe(5 * 60_000);
  });

  it("falls back to home for a missing cwd and states write permission", () => {
    const spec = buildDelegation({ account: WORK, task: "create an issue", write: true, cwd: join(sb.home, "gone"), maxTurns: 3, timeoutMs: 1000 }, sb.env);
    expect(spec.cwd).toBe(sb.home);
    expect(spec.args[1]).toMatch(/Write actions .* are allowed/);
    expect(spec.args.slice(-2)).toEqual(["--max-turns", "3"]);
    expect(spec.timeoutMs).toBe(1000);
  });

  it("parses the JSON result through an injected runner", async () => {
    let seen: RunSpec | undefined;
    const res = await delegate(
      { account: WORK, task: "t", write: false },
      {
        env: sb.env,
        runner: async (spec) => {
          seen = spec;
          return { code: 0, stdout: JSON.stringify({ type: "result", result: "3 open issues", is_error: false, total_cost_usd: 0.02, num_turns: 4 }), stderr: "", timedOut: false };
        },
      },
    );
    expect(seen?.args).toContain("dontAsk");
    expect(res).toMatchObject({ ok: true, text: "3 open issues", costUsd: 0.02, numTurns: 4 });
  });

  it("reports errors, timeouts and unparsable output", async () => {
    const run = (out: { code: number | null; stdout: string; stderr: string; timedOut: boolean }) =>
      delegate({ account: WORK, task: "t", write: false }, { env: sb.env, runner: async () => out });
    expect(await run({ code: 1, stdout: JSON.stringify({ result: "", is_error: true, subtype: "error_max_turns", num_turns: 15 }), stderr: "", timedOut: false })).toMatchObject({
      ok: false,
      numTurns: 15,
    });
    expect((await run({ code: null, stdout: "", stderr: "", timedOut: true })).text).toMatch(/timed out/);
    expect((await run({ code: 127, stdout: "", stderr: "command not found", timedOut: false })).text).toMatch(/exit 127.*command not found/);
    expect(parseClaudeJson('noise\n{"result":"x"}\n')).toEqual({ result: "x" });
  });

  it("runs a real launcher script in the sandbox bin", async () => {
    const argsLog = join(sb.home, "args.log");
    sb.write(
      ".local/bin/claude-work",
      `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argsLog)}
echo "pid=\${TURNO_SESSION_PID:-none}" >> ${JSON.stringify(argsLog)}
pwd >> ${JSON.stringify(argsLog)}
echo '{"type":"result","subtype":"success","is_error":false,"result":"done from work","total_cost_usd":0.5,"num_turns":2}'
`,
      0o755,
    );
    expect(launcherExists("work", sb.env)).toBe(true);
    expect(launcherExists("personal", sb.env)).toBe(false);
    const res = await delegate({ account: WORK, task: "t", write: false }, { env: { ...sb.env, TURNO_SESSION_PID: "99" } });
    expect(res).toMatchObject({ ok: true, text: "done from work", costUsd: 0.5, numTurns: 2 });
    const log = readFileSync(argsLog, "utf8");
    expect(log).toContain("--disallowedTools\nmcp__accounts__*\n");
    expect(log).toContain("pid=none");
    expect(log.trim().endsWith(sb.home)).toBe(true);
  });

  it("kills the launcher on timeout", async () => {
    sb.write(".local/bin/claude-work", "#!/bin/sh\nsleep 30\n", 0o755);
    const started = Date.now();
    const res = await delegate({ account: WORK, task: "t", write: false, timeoutMs: 300 }, { env: sb.env });
    expect(res.ok).toBe(false);
    expect(res.text).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("stops the launcher's process group when the caller cancels", async () => {
    const marker = join(sb.home, "grandchild.pid");
    sb.write(".local/bin/claude-work", `#!/bin/sh\nsleep 30 &\necho $! > ${JSON.stringify(marker)}\nwait\n`, 0o755);
    const ac = new AbortController();
    const started = Date.now();
    const run = delegate({ account: WORK, task: "t", write: false }, { env: sb.env, signal: ac.signal });
    for (let i = 0; i < 250 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 20));
    const grandchild = Number(readFileSync(marker, "utf8"));
    ac.abort();
    const res = await run;
    expect(res).toMatchObject({ ok: false, cancelled: true });
    expect(res.text).toMatch(/was cancelled/);
    expect(Date.now() - started).toBeLessThan(6000);
    const alive = () => {
      try {
        process.kill(grandchild, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(alive()).toBe(false);
  });

  it("does not start a run that was cancelled before it began", async () => {
    let ran = false;
    const ac = new AbortController();
    ac.abort();
    const res = await delegate(
      { account: WORK, task: "t", write: false },
      { env: sb.env, signal: ac.signal, runner: async (_spec, signal) => ((ran = !signal?.aborted), { code: null, stdout: "", stderr: "", timedOut: false, cancelled: true }) },
    );
    expect(ran).toBe(false);
    expect(res.cancelled).toBe(true);
  });
});

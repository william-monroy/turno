import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type RunSpec,
  buildDelegation,
  delegate,
  isolatedMcp,
  launcherExists,
  mcpServerOf,
  parseClaudeJson,
  prepareRun,
} from "../src/accounts/delegate.js";
import { paths } from "../src/core/paths.js";
import type { Account } from "../src/accounts/registry.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const WORK: Account = {
  id: "linear:work",
  service: "linear",
  label: "work",
  profile: "work",
  tools: ["mcp__linear__*", "mcp__linear2__get_issue"],
};

const GATEWAY = (name: string) => ({
  type: "http",
  url: `http://127.0.0.1:4100/mcp/${name}`,
  headers: { Authorization: "Bearer test-token", "X-Turno-Profile": "work" },
});

function profileConfig(servers: Record<string, unknown>): void {
  sb.write(".claude-work/.claude.json", JSON.stringify({ mcpServers: servers }));
}

describe("delegation command", () => {
  it("builds the enforced argv, a minimal env and turno's own folder", () => {
    const env = {
      ...sb.env,
      TURNO_SESSION_PID: "123",
      CLAUDE_CONFIG_DIR: join(sb.home, ".claude-personal"),
      ANTHROPIC_API_KEY: "sk-test",
      KEEP: "1",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      HTTPS_PROXY: "http://proxy.example:8080",
    };
    const run = { cwd: join(sb.home, "run"), mcpConfig: join(sb.home, "mcp.json") };
    const spec = buildDelegation(
      { account: WORK, task: "list my open issues", write: false, tools: ["mcp__linear__get_issue"] },
      run,
      env,
    );
    expect(spec.command).toBe(join(sb.home, ".local", "bin", "claude-work"));
    const a = spec.args;
    expect(a[0]).toBe("-p");
    expect(a[1]).toContain("list my open issues");
    expect(a[1]).toContain("linear:work");
    expect(a[1]).toContain("Use only these tools to reach it: mcp__linear__get_issue.");
    expect(a[1]).toMatch(/NOT allowed/);
    expect(a.slice(2)).toEqual([
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "",
      "--mcp-config",
      run.mcpConfig,
      "--strict-mcp-config",
      "--tools",
      "",
      "--allowedTools",
      "mcp__linear__get_issue",
      "--disallowedTools",
      "mcp__accounts__*",
      "--output-format",
      "json",
      "--max-turns",
      "15",
    ]);
    expect(spec.cwd).toBe(run.cwd);
    expect(Object.keys(spec.env).sort()).toEqual(
      ["HOME", "HTTPS_PROXY", "LANG", "LC_ALL", "PATH", "TMPDIR"].filter(
        (k) => env[k as keyof typeof env] !== undefined,
      ),
    );
    expect(spec.timeoutMs).toBe(5 * 60_000);
  });

  it("uses the account's tools by default, no strict MCP without a config, and states write permission", () => {
    const spec = buildDelegation(
      { account: WORK, task: "create an issue", write: true, maxTurns: 3, timeoutMs: 1000 },
      { cwd: sb.home },
      sb.env,
    );
    expect(spec.args).not.toContain("--strict-mcp-config");
    expect(spec.args).not.toContain("--mcp-config");
    expect(spec.args.slice(spec.args.indexOf("--allowedTools") + 1, spec.args.indexOf("--disallowedTools"))).toEqual(
      WORK.tools,
    );
    expect(spec.args[1]).toMatch(/Write actions .* are allowed/);
    expect(spec.args.slice(-2)).toEqual(["--max-turns", "3"]);
    expect(spec.timeoutMs).toBe(1000);
  });

  it("names the MCP server of a tool pattern", () => {
    expect(mcpServerOf("mcp__linear__*")).toBe("linear");
    expect(mcpServerOf("mcp__linear2__get_issue")).toBe("linear2");
    expect(mcpServerOf("mcp__linear")).toBe("linear");
    expect(mcpServerOf("WebFetch")).toBeUndefined();
  });

  it("loads only the account's gateway servers from the owning profile", () => {
    profileConfig({ linear: GATEWAY("linear"), linear2: GATEWAY("linear2"), github: GATEWAY("github") });
    const mcp = isolatedMcp("work", WORK.tools, sb.env);
    expect(mcp.strict).toBe(true);
    expect(Object.keys(mcp.servers).sort()).toEqual(["linear", "linear2"]);
    expect(isolatedMcp("work", ["mcp__linear__get_issue"], sb.env).servers).toEqual({ linear: GATEWAY("linear") });
  });

  it("keeps the profile's MCP config for connectors, missing and non-gateway servers", () => {
    profileConfig({
      linear: GATEWAY("linear"),
      remote: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer x" } },
    });
    expect(isolatedMcp("work", ["mcp__claude_ai_Gmail__*"], sb.env)).toMatchObject({
      strict: false,
      why: expect.stringMatching(/claude\.ai connector/),
    });
    expect(isolatedMcp("work", ["mcp__linear2__*"], sb.env)).toMatchObject({
      strict: false,
      why: expect.stringMatching(/not in the MCP config of profile work/),
    });
    expect(isolatedMcp("work", ["mcp__remote__*"], sb.env)).toMatchObject({
      strict: false,
      why: expect.stringMatching(/does not go through the turno gateway/),
    });
    expect(isolatedMcp("nobody", ["mcp__linear__*"], sb.env).strict).toBe(false);
  });

  it("prepares an empty private folder and a private MCP config, removed by cleanup", () => {
    profileConfig({ linear: GATEWAY("linear"), linear2: GATEWAY("linear2") });
    const run = prepareRun("work", WORK.tools, sb.env);
    expect(run.cwd).toBe(join(paths(sb.env).state, "delegate", "work"));
    expect(readdirSync(run.cwd)).toEqual([]);
    expect(statSync(run.cwd).mode & 0o777).toBe(0o700);
    expect(run.mcpConfig).toBeDefined();
    expect(statSync(run.mcpConfig!).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(run.mcpConfig!, "utf8")).mcpServers).sort()).toEqual([
      "linear",
      "linear2",
    ]);
    run.cleanup();
    expect(existsSync(run.mcpConfig!)).toBe(false);
    // Something left in the folder is cleared before the next run.
    writeFileSync(join(run.cwd, "CLAUDE.md"), "planted");
    expect(readdirSync(prepareRun("work", WORK.tools, sb.env).cwd)).toEqual([]);
  });

  it("parses the JSON result through an injected runner", async () => {
    let seen: RunSpec | undefined;
    const res = await delegate(
      { account: WORK, task: "t", write: false },
      {
        env: sb.env,
        runner: async (spec) => {
          seen = spec;
          return {
            code: 0,
            stdout: JSON.stringify({
              type: "result",
              result: "3 open issues",
              is_error: false,
              total_cost_usd: 0.02,
              num_turns: 4,
            }),
            stderr: "",
            timedOut: false,
          };
        },
      },
    );
    expect(seen?.args).toContain("dontAsk");
    expect(res).toMatchObject({ ok: true, text: "3 open issues", costUsd: 0.02, numTurns: 4 });
  });

  it("reports errors, timeouts and unparsable output", async () => {
    const run = (out: { code: number | null; stdout: string; stderr: string; timedOut: boolean }) =>
      delegate({ account: WORK, task: "t", write: false }, { env: sb.env, runner: async () => out });
    expect(
      await run({
        code: 1,
        stdout: JSON.stringify({ result: "", is_error: true, subtype: "error_max_turns", num_turns: 15 }),
        stderr: "",
        timedOut: false,
      }),
    ).toMatchObject({
      ok: false,
      numTurns: 15,
    });
    expect((await run({ code: null, stdout: "", stderr: "", timedOut: true })).text).toMatch(/timed out/);
    expect((await run({ code: 127, stdout: "", stderr: "command not found", timedOut: false })).text).toMatch(
      /exit 127.*command not found/,
    );
    expect(parseClaudeJson('noise\n{"result":"x"}\n')).toEqual({ result: "x" });
  });

  it("runs a fake launcher in turno's folder with the minimal env and the account's servers only", async () => {
    profileConfig({ linear: GATEWAY("linear"), linear2: GATEWAY("linear2"), github: GATEWAY("github") });
    const log = join(sb.home, "fake");
    sb.write(
      ".local/bin/claude-work",
      `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(`${log}.argv`)}
pwd > ${JSON.stringify(`${log}.cwd`)}
ls -A >> ${JSON.stringify(`${log}.cwd`)}
env > ${JSON.stringify(`${log}.env`)}
while [ $# -gt 0 ]; do
  if [ "$1" = "--mcp-config" ]; then cp "$2" ${JSON.stringify(`${log}.mcp`)}; fi
  shift
done
echo '{"type":"result","subtype":"success","is_error":false,"result":"done from work","total_cost_usd":0.5,"num_turns":2,"permission_denials":[{"tool_name":"mcp__linear__create_issue","tool_use_id":"t1","tool_input":{}},{"tool_name":"mcp__linear__create_issue","tool_use_id":"t2","tool_input":{}}]}'
`,
      0o755,
    );
    expect(launcherExists("work", sb.env)).toBe(true);
    expect(launcherExists("personal", sb.env)).toBe(false);
    const env = {
      ...sb.env,
      TURNO_SESSION_PID: "99",
      CLAUDE_CONFIG_DIR: join(sb.home, ".claude-personal"),
      ANTHROPIC_API_KEY: "sk-test",
      OTHER_SECRET: "s3cret",
    };
    const res = await delegate({ account: WORK, task: "t", write: false, tools: ["mcp__linear__get_issue"] }, { env });
    expect(res).toMatchObject({
      ok: true,
      text: "done from work",
      costUsd: 0.5,
      numTurns: 2,
      denied: ["mcp__linear__create_issue"],
      mcp: "strict",
    });
    const argv = readFileSync(`${log}.argv`, "utf8");
    expect(argv).toContain("--setting-sources\n\n");
    expect(argv).toContain("--strict-mcp-config\n");
    expect(argv).toContain("--allowedTools\nmcp__linear__get_issue\n--disallowedTools\nmcp__accounts__*\n");
    const [cwd, ...files] = readFileSync(`${log}.cwd`, "utf8").trim().split("\n");
    expect(cwd).toBe(join(paths(sb.env).state, "delegate", "work"));
    expect(files).toEqual([]);
    const childEnv = readFileSync(`${log}.env`, "utf8");
    expect(childEnv).not.toMatch(/TURNO_SESSION_PID|CLAUDE_CONFIG_DIR|ANTHROPIC_API_KEY|OTHER_SECRET/);
    expect(childEnv).toContain(`HOME=${sb.home}`);
    // The servers of this account only (one tool of linear here), and the per-run file is gone.
    expect(Object.keys(JSON.parse(readFileSync(`${log}.mcp`, "utf8")).mcpServers)).toEqual(["linear"]);
    expect(readdirSync(join(paths(sb.env).state, "delegate")).filter((f) => f.startsWith(".run-"))).toEqual([]);
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
    // The shell creates the marker before it writes the pid, so wait for the pid itself: an empty
    // read gives 0, and process.kill(0, 0) signals our own group, which always looks alive.
    const readPid = () => (existsSync(marker) ? Number(readFileSync(marker, "utf8").trim()) || 0 : 0);
    for (let i = 0; i < 250 && readPid() === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const grandchild = readPid();
    expect(grandchild).toBeGreaterThan(0);
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
    for (let i = 0; i < 150 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(alive()).toBe(false);
  });

  it("does not start a run that was cancelled before it began", async () => {
    let ran = false;
    const ac = new AbortController();
    ac.abort();
    const res = await delegate(
      { account: WORK, task: "t", write: false },
      {
        env: sb.env,
        signal: ac.signal,
        runner: async (_spec, signal) => (
          (ran = !signal?.aborted), { code: null, stdout: "", stderr: "", timedOut: false, cancelled: true }
        ),
      },
    );
    expect(ran).toBe(false);
    expect(res.cancelled).toBe(true);
  });
});

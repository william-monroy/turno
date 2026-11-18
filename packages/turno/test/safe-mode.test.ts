import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isGatewayEntry } from "../src/agents/adapter.js";
import { adapter } from "../src/agents/index.js";
import { wantsSafe } from "../src/cli/launch.js";
import { main } from "../src/cli/main.js";
import { safeEnv, safePlan, takeSafeFlag } from "../src/cli/safe.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
let savedExecve: typeof process.execve;

beforeEach(() => {
  sb = sandbox();
  // Without execve turno runs the agent as a child, so the test process stays.
  savedExecve = process.execve;
  (process as { execve?: unknown }).execve = undefined;
});

afterEach(() => {
  (process as { execve?: unknown }).execve = savedExecve;
  sb.cleanup();
});

async function run(args: string[], env = sb.env) {
  const io = fakeIo(env);
  const code = await main(args, io);
  return { code, out: io.lines.join("\n"), err: io.errors.join("\n") };
}

/** A fake agent that writes its arguments and environment to files in HOME. */
function fakeAgent(command: string): void {
  fakeCommand(sb, command, `printf '%s\\n' "$@" > "$HOME/agent-args.txt"\nenv > "$HOME/agent-env.txt"`);
}

const agentArgs = () => readFileSync(join(sb.home, "agent-args.txt"), "utf8").trim().split("\n").filter(Boolean);
const agentEnv = () => Object.fromEntries(readFileSync(join(sb.home, "agent-env.txt"), "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

const gateway = (agent: "claude" | "codex" | "copilot" | "cursor", name: string) => adapter(agent).mcp.gatewayEntry(name, 47821, "tok", "work");

describe("the safe-mode switch", () => {
  it("takes --no-gateway out of turno's arguments only, before --", () => {
    expect(takeSafeFlag(["--no-gateway", "--resume"])).toEqual({ args: ["--resume"], safe: true });
    expect(takeSafeFlag(["--resume", "--", "--no-gateway"])).toEqual({ args: ["--resume", "--", "--no-gateway"], safe: false });
    expect(wantsSafe(["x", "--no-gateway"], {})).toBe(true);
    expect(wantsSafe(["--", "--no-gateway"], {})).toBe(false);
  });

  it("reads TURNO_SAFE: 1 or true on, 0, false or empty off", () => {
    expect(wantsSafe([], { TURNO_SAFE: "1" })).toBe(true);
    expect(wantsSafe([], { TURNO_SAFE: "true" })).toBe(true);
    for (const v of ["0", "false", "FALSE", ""]) expect(wantsSafe([], { TURNO_SAFE: v })).toBe(false);
    expect(wantsSafe([], {})).toBe(false);
  });

  it("knows the gateway entries of every agent, and nothing else", () => {
    for (const agent of ["claude", "codex", "copilot", "cursor"] as const) expect(isGatewayEntry(gateway(agent, "fx")), agent).toBe(true);
    expect(isGatewayEntry({ command: "npx", args: ["x"] })).toBe(false);
    expect(isGatewayEntry({ type: "http", url: "https://mcp.example.com/mcp" })).toBe(false);
  });
});

describe("safePlan", () => {
  it("Claude Code: a strict MCP config with the profile's other servers, and no status line or hooks", () => {
    const cwd = join(sb.home, "code/app");
    sb.write("code/app/.mcp.json", JSON.stringify({ mcpServers: { local: { command: "local-mcp" }, gw2: gateway("claude", "gw2") } }));
    const cfg = sb.write(
      ".claude-work/.claude.json",
      JSON.stringify({
        mcpServers: { fx: gateway("claude", "fx"), mine: { command: "mine-mcp", env: { TOKEN: "literal" } } },
        projects: { [cwd]: { mcpServers: { proj: { type: "http", url: "https://example.com/mcp" } } } },
      }),
    );
    const plan = safePlan("claude", cfg, cwd, sb.env, "work");
    expect(plan.args.slice(0, 2)).toEqual(["--strict-mcp-config", "--mcp-config"]);
    expect(plan.args.slice(3)).toEqual(["--settings", '{"disableAllHooks":true}']);
    const file = plan.args[2]!;
    expect(file).toBe(join(sb.home, ".local/state/turno/safe/work.mcp.json"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).mcpServers).sort()).toEqual(["local", "mine", "proj"]);
    expect(plan.notes.join("\n")).toMatch(/left out the gateway entries fx, gw2/);
  });

  it("Codex: -c mcp_servers.<name>.enabled=false for each gateway entry", () => {
    const cfg = sb.write(
      ".codex-cx/config.toml",
      [
        'cli_auth_credentials_store = "file"',
        "[mcp_servers.fx]",
        'url = "http://127.0.0.1:47821/mcp/fx"',
        'bearer_token_env_var = "TURNO_MCPD_TOKEN"',
        "[mcp_servers.own]",
        'command = "own-mcp"',
        "",
      ].join("\n"),
    );
    expect(safePlan("codex", cfg, sb.home, sb.env, "cx").args).toEqual(["-c", "mcp_servers.fx.enabled=false"]);
  });

  it("Copilot CLI: --disable-mcp-server for each gateway entry", () => {
    const cfg = sb.write(".copilot-cp/mcp-config.json", JSON.stringify({ mcpServers: { a: gateway("copilot", "a"), b: gateway("copilot", "b"), own: { command: "x" } } }));
    expect(safePlan("copilot", cfg, sb.home, sb.env, "cp").args).toEqual(["--disable-mcp-server=a", "--disable-mcp-server=b"]);
  });

  it("Cursor CLI: no arguments; the entries start without a token and mcpd refuses them", () => {
    const cfg = sb.write(".cursor/mcp.json", JSON.stringify({ mcpServers: { fx: gateway("cursor", "fx") } }));
    const plan = safePlan("cursor", cfg, sb.home, sb.env, "cu");
    expect(plan.args).toEqual([]);
    expect(plan.notes.join("\n")).toMatch(/without the gateway token/);
  });

  it("keeps the profile's account and drops the gateway variables", () => {
    const env = safeEnv("codex", "cx", { ...sb.env, TURNO_MCPD_TOKEN: "t", TURNO_SESSION_PID: "1", TURNO_SESSION_CWD_B64: "x" }, "darwin");
    expect(env.CODEX_HOME).toBe(join(sb.home, ".codex-cx"));
    expect(env.TURNO_PROFILE).toBe("cx");
    expect(env.TURNO_AGENT).toBe("codex");
    expect(env.TURNO_SAFE).toBe("1");
    expect(env.BROWSER).toBe(join(sb.home, ".local/bin/turno-open"));
    for (const v of ["TURNO_MCPD_TOKEN", "TURNO_SESSION_PID", "TURNO_SESSION_CWD_B64"]) expect(env[v]).toBeUndefined();
    expect(safeEnv("cursor", "cu", sb.env, "darwin").AGENT_CLI_CREDENTIAL_STORE).toBe("file");
  });
});

describe("turno run --no-gateway", () => {
  beforeEach(() => {
    sb.write(".config/turno/config.toml", '[profiles.work]\n[profiles.pilot]\nagent = "copilot"\n');
    sb.write(".claude-work/.claude.json", JSON.stringify({ mcpServers: { fx: gateway("claude", "fx") } }));
    sb.write(".copilot-pilot/mcp-config.json", JSON.stringify({ mcpServers: { fx: gateway("copilot", "fx") } }));
  });

  it("opens the agent with the profile's folder, without the launcher or the gateway token", async () => {
    fakeAgent("claude");
    const r = await run(["run", "work", "--no-gateway", "--resume"], { ...sb.env, TURNO_MCPD_TOKEN: "leak" });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/safe mode, profile work without the gateway/);
    const args = agentArgs();
    expect(args).toContain("--strict-mcp-config");
    expect(args.at(-1)).toBe("--resume");
    expect(args).not.toContain("--no-gateway");
    const env = agentEnv();
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(sb.home, ".claude-work"));
    expect(env.TURNO_SAFE).toBe("1");
    expect(env.TURNO_MCPD_TOKEN).toBeUndefined();
  });

  it("takes the flag before the profile, from `turno <profile>`, and from TURNO_SAFE=1", async () => {
    fakeAgent("copilot");
    expect((await run(["run", "--no-gateway", "pilot"])).code).toBe(0);
    expect(agentArgs()).toEqual(["--disable-mcp-server=fx"]);
    expect((await run(["pilot", "--no-gateway", "-p", "hi"])).code).toBe(0);
    expect(agentArgs()).toEqual(["--disable-mcp-server=fx", "-p", "hi"]);
    expect((await run(["pilot"], { ...sb.env, TURNO_SAFE: "1" })).code).toBe(0);
    expect(agentArgs()).toEqual(["--disable-mcp-server=fx"]);
  });

  it("works for turno auto, with the folder's profile", async () => {
    fakeAgent("claude");
    sb.write(".config/turno/config.toml", 'default = "work"\n[profiles.work]\n');
    sb.write(".local/bin/claude-work", "#!/bin/sh\nexit 9\n", 0o755);
    const r = await run(["auto", "--no-gateway"]);
    expect(r.code).toBe(0);
    expect(agentEnv().CLAUDE_CONFIG_DIR).toBe(join(sb.home, ".claude-work"));
  });

  it("exits 127 when the agent is not installed, and 2 for an unknown profile", async () => {
    sb.env.PATH = "/usr/bin:/bin";
    expect((await run(["run", "work", "--no-gateway"])).code).toBe(127);
    expect((await run(["run", "nope", "--no-gateway"])).code).toBe(2);
  });
});

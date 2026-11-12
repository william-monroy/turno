import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseManifest } from "../src/core/manifest.js";
import { type RunningDaemon, startDaemon } from "../src/mcpd/daemon.js";
import { profileServers } from "../src/mcpd/sync.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fixture-server.mjs", import.meta.url));

function hasClaude(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

// Talks to the real Claude Code binary. Skipped when it is missing or CLAUDIO_SKIP_E2E is set.
describe.skipIf(!hasClaude() || Boolean(process.env.CLAUDIO_SKIP_E2E))("Claude Code against mcpd", () => {
  let sb: Sandbox;
  let daemon: RunningDaemon | undefined;
  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(async () => {
    await daemon?.stop();
    sb.cleanup();
  });

  it("connects through the gateway and lists tools without starting the server twice", async () => {
    const log = join(sb.home, "spawns.log");
    const toml = `[server.fx]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(FIXTURE)}]\nenv = { FIXTURE_LOG = ${JSON.stringify(log)} }\n`;
    sb.write(".config/claudio/mcp.toml", toml);
    daemon = await startDaemon({ env: sb.env, port: 0 });
    const token = readFileSync(join(sb.home, ".local/state/claudio/mcpd.token"), "utf8").trim();
    const cfgDir = join(sb.home, ".claude-work");
    mkdirSync(cfgDir, { recursive: true });
    const servers = profileServers(parseManifest(toml), "work", daemon.port, token);
    writeFileSync(join(cfgDir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: servers }));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfgDir, CLAUDIO_SESSION_PID: String(process.pid) };
    // Async on purpose: the daemon runs in this process and must keep serving.
    const run = async () => (await promisify(execFile)("claude", ["mcp", "list"], { env, encoding: "utf8", timeout: 90_000 })).stdout;
    expect(await run()).toMatch(/fx: .*Connected/);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    await daemon.manager.stopAll();
    expect(await run()).toMatch(/fx: .*Connected/);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1); // served from cache
  }, 200_000);
});

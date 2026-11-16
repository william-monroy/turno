import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseManifest } from "../src/core/manifest.js";
import { type RunningDaemon, startDaemon } from "../src/mcpd/daemon.js";
import { profileServers, syncCodexToml, syncJsonServers } from "../src/mcpd/sync.js";
import { profileToken } from "../src/mcpd/tokens.js";
import { hasBinary, networkE2e, realBinEnv, skipE2e } from "./helpers/e2e.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fixture-server.mjs", import.meta.url));

const manifest = (log: string) =>
  `[server.fx]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(FIXTURE)}]\nenv = { FIXTURE_LOG = ${JSON.stringify(log)} }\n`;

// Talk to the real agent binaries, in a sandbox HOME. Skipped when one is missing or TURNO_SKIP_E2E is set.
// Cursor needs its servers, so it runs only with TURNO_E2E_NETWORK=1 (`pnpm test:e2e`).
describe("other agents against mcpd", () => {
  let sb: Sandbox;
  let daemon: RunningDaemon | undefined;
  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    sb.cleanup();
  });

  it.skipIf(skipE2e || !networkE2e || !hasBinary("cursor-agent"))(
    "Cursor connects through the shared mcp.json with the token and profile from the environment",
    async () => {
      const toml = manifest(join(sb.home, "spawns.log"));
      sb.write(".config/turno/mcp.toml", toml);
      daemon = await startDaemon({ env: sb.env, port: 0 });
      const token = readFileSync(join(sb.home, ".local/state/turno/mcpd.token"), "utf8").trim();
      const file = join(sb.home, ".cursor/mcp.json");
      syncJsonServers(file, "mcpServers", profileServers(parseManifest(toml), "", daemon.port, token, "cursor"), []);
      expect(readFileSync(file, "utf8")).not.toContain(token);
      const env = realBinEnv(sb, {
        CURSOR_CONFIG_DIR: join(sb.home, ".cursor-cur"),
        AGENT_CLI_CREDENTIAL_STORE: "file",
        // What the cursor-cur launcher reads from its token file (ADR 0023).
        TURNO_MCPD_TOKEN: profileToken(token, "cur"),
        TURNO_PROFILE: "cur",
        TURNO_SESSION_PID: String(process.pid),
      });
      const cursor = async (args: string[], e: NodeJS.ProcessEnv) =>
        (await promisify(execFile)("cursor-agent", args, { env: e, cwd: sb.home, encoding: "utf8", timeout: 90_000 })).stdout;
      const run = (e: NodeJS.ProcessEnv) => cursor(["mcp", "list"], e);
      // Cursor asks the user to approve each new server once.
      expect(await run(env)).toMatch(/fx: not loaded \(needs approval\)/);
      await cursor(["mcp", "enable", "fx"], env);
      expect(await run(env)).toMatch(/fx: ready/);
      // Outside a turno launcher there is no token: the gateway refuses.
      expect(await run({ ...env, TURNO_MCPD_TOKEN: "" })).not.toMatch(/fx: ready/);
    },
    200_000,
  );

  it.skipIf(skipE2e || !hasBinary("codex"))("Codex reads the gateway entries turno writes, with the token left in the environment", async () => {
    const toml = manifest(join(sb.home, "spawns.log"));
    const file = sb.write(".codex-cx/config.toml", 'cli_auth_credentials_store = "file"\n');
    syncCodexToml(file, profileServers(parseManifest(toml), "cx", 47821, "secret-token", "codex"), []);
    const env = realBinEnv(sb, { CODEX_HOME: join(sb.home, ".codex-cx") });
    const out = execFileSync("codex", ["mcp", "get", "fx", "--json"], { env, cwd: sb.home, encoding: "utf8", timeout: 60_000 });
    const entry = JSON.parse(out) as { transport: Record<string, unknown> };
    expect(entry.transport).toMatchObject({
      type: "streamable_http",
      url: "http://127.0.0.1:47821/mcp/fx",
      bearer_token_env_var: "TURNO_MCPD_TOKEN",
      http_headers: { "X-Turno-Profile": "cx" },
      env_http_headers: { "X-Turno-Pid": "TURNO_SESSION_PID", "X-Turno-Cwd-B64": "TURNO_SESSION_CWD_B64" },
    });
    expect(readFileSync(file, "utf8")).not.toContain("secret-token");
    // A fresh profile is logged out: the login is per CODEX_HOME, not the shared Keychain.
    let status = "";
    try {
      status = execFileSync("codex", ["login", "status"], { env, cwd: sb.home, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      status = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    expect(status).toMatch(/Not logged in/);
  }, 120_000);
});

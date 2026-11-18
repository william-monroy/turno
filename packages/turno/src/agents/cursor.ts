import { join } from "node:path";
import { paths } from "../core/paths.js";
import { readJsonFile } from "../core/fsutil.js";
import { type AgentAdapter, JSON_MCP_SERVERS, gatewayNames, gatewayUrl } from "./adapter.js";

export const cursor: AgentAdapter = {
  id: "cursor",
  label: "Cursor CLI",
  command: "cursor-agent",
  homeEnv: "CURSOR_CONFIG_DIR",
  dirPrefix: ".cursor-",
  launcherPrefix: "cursor-agent-",
  install: "curl https://cursor.com/install -fsS | bash",
  loginSubcommand: "login",
  hub: (env) => join(paths(env).home, ".cursor"),
  homeMarkers: ["cli-config.json", "mcp.json"],
  sharedDirs: [],
  sharedFiles: [],
  // Without it every config dir shares the Keychain login (verified 2026-11-13, undocumented).
  launcherEnv: { AGENT_CLI_CREDENTIAL_STORE: "file" },
  classicLauncher: false,
  tokenFromEnv: true,
  accountDetails: false,
  mcp: {
    store: JSON_MCP_SERVERS,
    // CURSOR_CONFIG_DIR does not move mcp.json: every profile shares the hub's.
    file: (_dir, env) => join(cursor.hub(env), "mcp.json"),
    shared: true,
    hubFile: (env) => join(cursor.hub(env), "mcp.json"),
    directRemote: false,
    // One file for every profile, so even the profile comes from the launcher's environment;
    // Cursor resolves `${env:NAME}` in url and headers, the CLI too (docs/agents.md).
    gatewayEntry: (name, port) => ({
      url: gatewayUrl(name, port),
      headers: {
        Authorization: "Bearer ${env:TURNO_MCPD_TOKEN}",
        "X-Turno-Profile": "${env:TURNO_PROFILE}",
        "X-Turno-Pid": "${env:TURNO_SESSION_PID}",
        "X-Turno-Cwd-B64": "${env:TURNO_SESSION_CWD_B64}",
      },
    }),
    afterSync: (added) => `  Cursor asks to approve new servers once: cursor-agent mcp enable <name> (${added.join(", ")})`,
  },
  // Safe mode: Cursor CLI has no switch for one run (only `agent mcp disable`, which lasts). Its
  // entries read the token from the environment, which safe mode leaves out, so mcpd refuses them.
  safeMode(s) {
    const cfg = readJsonFile(s.file);
    const names = gatewayNames(typeof cfg === "object" && cfg !== null ? (cfg as Record<string, unknown>).mcpServers : undefined);
    return {
      args: [],
      notes: [
        names.length
          ? `Cursor cannot turn servers off for one run: ${names.join(", ")} start without the gateway token, so mcpd refuses them and they show as failed`
          : "no gateway entries in the shared mcp.json",
      ],
    };
  },
};

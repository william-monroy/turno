import { join } from "node:path";
import { paths } from "../core/paths.js";
import { type AgentAdapter, JSON_MCP_SERVERS, gatewayUrl } from "./adapter.js";

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
    // One file for every profile, so even the profile comes from the launcher's environment.
    gatewayEntry: (name, port) => ({
      url: gatewayUrl(name, port),
      headers: {
        Authorization: "Bearer ${env:TURNO_MCPD_TOKEN}",
        "X-Turno-Profile": "${env:TURNO_PROFILE}",
        "X-Turno-Pid": "${env:TURNO_SESSION_PID}",
      },
    }),
    afterSync: (added) => `  Cursor asks to approve new servers once: cursor-agent mcp enable <name> (${added.join(", ")})`,
  },
};

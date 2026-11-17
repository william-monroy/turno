import { join } from "node:path";
import { paths } from "../core/paths.js";
import { type AgentAdapter, JSON_MCP_SERVERS, gatewayUrl } from "./adapter.js";

export const copilot: AgentAdapter = {
  id: "copilot",
  label: "GitHub Copilot CLI",
  command: "copilot",
  homeEnv: "COPILOT_HOME",
  dirPrefix: ".copilot-",
  launcherPrefix: "copilot-",
  install: "npm install --global @github/copilot",
  hub: (env) => join(paths(env).home, ".copilot"),
  homeMarkers: ["config.json", "mcp-config.json", "session-state"],
  sharedDirs: ["session-state"],
  sharedFiles: [],
  launcherEnv: {},
  classicLauncher: false,
  tokenFromEnv: true,
  accountDetails: false,
  mcp: {
    store: JSON_MCP_SERVERS,
    file: (dir) => join(dir, "mcp-config.json"),
    shared: false,
    hubFile: (env) => join(copilot.hub(env), "mcp-config.json"),
    directRemote: false,
    // `${VAR}` expansion in Copilot's headers is from its documentation, not verified (ADR 0013).
    gatewayEntry: (name, port, _token, profile) => ({
      type: "http",
      url: gatewayUrl(name, port),
      headers: {
        Authorization: "Bearer ${TURNO_MCPD_TOKEN}",
        "X-Turno-Profile": profile,
        "X-Turno-Pid": "${TURNO_SESSION_PID}",
      },
      tools: ["*"],
    }),
  },
};

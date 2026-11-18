import { join } from "node:path";
import { paths } from "../core/paths.js";
import { readJsonFile } from "../core/fsutil.js";
import { type AgentAdapter, JSON_MCP_SERVERS, gatewayNames, gatewayUrl } from "./adapter.js";

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
    // Copilot CLI expands `${VAR}` in a remote server's headers ("Supports variable expansion",
    // CLI command reference); not verified against the real CLI yet. The folder is
    // the launcher's, base64url like Claude Code's and Codex's (docs/agents.md).
    gatewayEntry: (name, port, _token, profile) => ({
      type: "http",
      url: gatewayUrl(name, port),
      headers: {
        Authorization: "Bearer ${TURNO_MCPD_TOKEN}",
        "X-Turno-Profile": profile,
        "X-Turno-Pid": "${TURNO_SESSION_PID}",
        "X-Turno-Cwd-B64": "${TURNO_SESSION_CWD_B64}",
      },
      tools: ["*"],
    }),
  },
  // Safe mode: `--disable-mcp-server=<name>` ("can be used multiple times") for each gateway entry.
  safeMode(s) {
    const cfg = readJsonFile(s.file);
    const names = gatewayNames(
      typeof cfg === "object" && cfg !== null ? (cfg as Record<string, unknown>).mcpServers : undefined,
    );
    return {
      args: names.map((n) => `--disable-mcp-server=${n}`),
      notes: [
        names.length
          ? `turned off the gateway entries ${names.join(", ")} for this run`
          : "no gateway entries to turn off",
      ],
    };
  },
};

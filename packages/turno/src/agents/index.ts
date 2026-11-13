import { join } from "node:path";
import { paths } from "../core/paths.js";

/** The coding agents turno manages profiles for (ADR 0013). */
export const AGENT_IDS = ["claude", "codex", "copilot", "cursor"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export function isAgentId(v: unknown): v is AgentId {
  return typeof v === "string" && (AGENT_IDS as readonly string[]).includes(v);
}

/** Where and how gateway entries are written for an agent. */
export type McpFormat = "claude" | "codex" | "copilot" | "cursor";

export interface AgentAdapter {
  id: AgentId;
  /** Product name for messages. */
  label: string;
  /** Program the launcher execs, looked up on PATH. */
  command: string;
  /** Environment variable that moves the agent's whole home. */
  homeEnv: string;
  /** Profile directory name prefix under $HOME: `.claude-` gives ~/.claude-<name>. */
  dirPrefix: string;
  /** Launcher name prefix in ~/.local/bin: `claude-` gives claude-<name>. */
  launcherPrefix: string;
  /** Hub folders linked into every profile of this agent. */
  sharedDirs: readonly string[];
  /** Hub files linked into every profile when they exist in the hub. */
  sharedFiles: readonly string[];
  /** Extra `export` lines of the launcher (shell words, already quoted). */
  launcherEnv: readonly string[];
  /** The launcher exports TURNO_MCPD_TOKEN, because the agent reads the gateway token from the environment. */
  tokenFromEnv: boolean;
  mcp: McpFormat;
  /** True when every profile shares one MCP file (Cursor's ~/.cursor/mcp.json). */
  sharedMcpFile: boolean;
  /** Install hint for doctor. */
  install: string;
}

const CLAUDE: AgentAdapter = {
  id: "claude",
  label: "Claude Code",
  command: "claude",
  homeEnv: "CLAUDE_CONFIG_DIR",
  dirPrefix: ".claude-",
  launcherPrefix: "claude-",
  // The Claude Code lists live in cli/launchers.ts (SHARED_DIRS) and setup.ts (SHARED_FILES).
  sharedDirs: [],
  sharedFiles: [],
  launcherEnv: [],
  tokenFromEnv: false,
  mcp: "claude",
  sharedMcpFile: false,
  install: "https://docs.claude.com/claude-code",
};

const CODEX: AgentAdapter = {
  id: "codex",
  label: "Codex CLI",
  command: "codex",
  homeEnv: "CODEX_HOME",
  dirPrefix: ".codex-",
  launcherPrefix: "codex-",
  // Rollouts in sessions/ let `codex resume <id>` continue a session with another account
  // (not verified across ChatGPT accounts yet; ADR 0013).
  sharedDirs: ["sessions", "prompts", "skills"],
  sharedFiles: ["AGENTS.md"],
  launcherEnv: [],
  tokenFromEnv: true,
  mcp: "codex",
  sharedMcpFile: false,
  install: "npm install --global @openai/codex",
};

const COPILOT: AgentAdapter = {
  id: "copilot",
  label: "GitHub Copilot CLI",
  command: "copilot",
  homeEnv: "COPILOT_HOME",
  dirPrefix: ".copilot-",
  launcherPrefix: "copilot-",
  sharedDirs: ["session-state"],
  sharedFiles: [],
  launcherEnv: [],
  tokenFromEnv: true,
  mcp: "copilot",
  sharedMcpFile: false,
  install: "npm install --global @github/copilot",
};

const CURSOR: AgentAdapter = {
  id: "cursor",
  label: "Cursor CLI",
  command: "cursor-agent",
  homeEnv: "CURSOR_CONFIG_DIR",
  dirPrefix: ".cursor-",
  launcherPrefix: "cursor-agent-",
  sharedDirs: [],
  sharedFiles: [],
  // Without it every config dir shares the Keychain login (verified 2026-11-13, undocumented).
  launcherEnv: ["export AGENT_CLI_CREDENTIAL_STORE=file"],
  tokenFromEnv: true,
  mcp: "cursor",
  sharedMcpFile: true,
  install: "curl https://cursor.com/install -fsS | bash",
};

const ADAPTERS: Record<AgentId, AgentAdapter> = { claude: CLAUDE, codex: CODEX, copilot: COPILOT, cursor: CURSOR };

export function adapter(id: AgentId = "claude"): AgentAdapter {
  return ADAPTERS[id];
}

/** The agent's own home, shared by every profile of that agent: ~/.claude, ~/.codex, ... */
export function agentHub(id: AgentId, env: NodeJS.ProcessEnv = process.env): string {
  const p = paths(env);
  if (id === "claude") return p.hub;
  return join(p.home, `.${id}`);
}

/** The profile's home: ~/.claude-<name>, ~/.codex-<name>, ... */
export function agentProfileDir(name: string, id: AgentId, env: NodeJS.ProcessEnv = process.env): string {
  return join(paths(env).home, `${adapter(id).dirPrefix}${name}`);
}

/** The file that holds a profile's MCP entries, or the shared one for Cursor. */
export function mcpFileFor(name: string, id: AgentId, env: NodeJS.ProcessEnv = process.env): string {
  const dir = agentProfileDir(name, id, env);
  switch (adapter(id).mcp) {
    case "claude":
      return join(dir, ".claude.json");
    case "codex":
      return join(dir, "config.toml");
    case "copilot":
      return join(dir, "mcp-config.json");
    case "cursor":
      return join(agentHub("cursor", env), "mcp.json");
  }
}

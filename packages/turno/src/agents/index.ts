import { join } from "node:path";
import { paths } from "../core/paths.js";
import type { AgentAdapter } from "./adapter.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { copilot } from "./copilot.js";
import { cursor } from "./cursor.js";

/**
 * The registry of coding agents turno manages profiles for (ADR 0013, ADR 0032). Adding an
 * agent is one adapter file next to this one plus its entries here.
 */
export const AGENT_IDS = ["claude", "codex", "copilot", "cursor"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

const ADAPTERS: Record<AgentId, AgentAdapter> = { claude, codex, copilot, cursor };

/**
 * The agent of a profile without `agent =`. It also owns the top-level `default`, `fallback`
 * and `system` of config.toml, and messages leave its name out.
 */
export const DEFAULT_AGENT: AgentId = "claude";

/**
 * The order turno reads agent configs in: `turno mcp import` (the first source wins a name) and
 * `turno doctor --security`.
 */
export const SCAN_ORDER: readonly AgentId[] = ["claude", "codex", "cursor", "copilot"];

export function isAgentId(v: unknown): v is AgentId {
  return typeof v === "string" && (AGENT_IDS as readonly string[]).includes(v);
}

export function adapter(id: AgentId = DEFAULT_AGENT): AgentAdapter {
  return ADAPTERS[id];
}

/** The agent's own home, shared by every profile of that agent: ~/.claude, ~/.codex, ... */
export function agentHub(id: AgentId, env: NodeJS.ProcessEnv): string {
  return ADAPTERS[id].hub(env);
}

/** The profile's home: ~/.claude-<name>, ~/.codex-<name>, ... */
export function agentProfileDir(name: string, id: AgentId, env: NodeJS.ProcessEnv): string {
  return join(paths(env).home, `${ADAPTERS[id].dirPrefix}${name}`);
}

/** The file that holds a profile's MCP entries, or the shared one for Cursor. */
export function mcpFileFor(name: string, id: AgentId, env: NodeJS.ProcessEnv): string {
  return ADAPTERS[id].mcp.file(agentProfileDir(name, id, env), env);
}

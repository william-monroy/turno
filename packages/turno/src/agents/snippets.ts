import { gatewayUrl } from "./adapter.js";

/**
 * Config snippets that point agents turno does not manage at the MCP gateway (ADR 0013).
 * turno prints them; the user pastes them. The token is never printed: each snippet reads it
 * from TURNO_MCPD_TOKEN where the agent expands variables, and says so where it does not.
 */

export const SNIPPET_AGENTS = ["opencode", "gemini", "goose", "crush", "droid", "kiro"] as const;
export type SnippetAgent = (typeof SNIPPET_AGENTS)[number];

export function isSnippetAgent(v: string): v is SnippetAgent {
  return (SNIPPET_AGENTS as readonly string[]).includes(v);
}

export interface Snippet {
  /** Where the snippet goes. */
  file: string;
  /** The snippet itself (JSON or YAML). */
  text: string;
  /** What the user must know: how the token reaches the agent, what is unverified. */
  notes: string[];
}

const url = (port: number, name: string) => gatewayUrl(name, port);
/** How the profile's own token (ADR 0023) reaches an agent that expands variables. */
const tokenEnv = (file: string) => `Start the agent with TURNO_MCPD_TOKEN set to this profile's token, e.g. in your shell profile: export TURNO_MCPD_TOKEN="$(cat ${file})"`;

function headers(profile: string, token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "X-Turno-Profile": profile };
}

function json(v: unknown): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}

export function gatewaySnippet(
  agent: SnippetAgent,
  servers: string[],
  port: number,
  profile: string,
  tokenFile = `~/.local/state/turno/mcpd-tokens/${profile}.token`,
): Snippet {
  const TOKEN_ENV = tokenEnv(tokenFile);
  const each = <T>(f: (name: string) => T): Record<string, T> => Object.fromEntries(servers.map((n) => [n, f(n)]));
  switch (agent) {
    case "opencode":
      return {
        file: "opencode.json (project) or ~/.config/opencode/opencode.json",
        text: json({ mcp: each((n) => ({ type: "remote", url: url(port, n), headers: headers(profile, "{env:TURNO_MCPD_TOKEN}"), enabled: true })) }),
        notes: [TOKEN_ENV],
      };
    case "gemini":
      return {
        file: "~/.gemini/settings.json (or .gemini/settings.json in a project)",
        text: json({ mcpServers: each((n) => ({ httpUrl: url(port, n), headers: headers(profile, "${TURNO_MCPD_TOKEN}") })) }),
        notes: [TOKEN_ENV],
      };
    case "goose": {
      const lines = ["extensions:"];
      for (const n of servers) {
        lines.push(
          `  ${n}:`,
          `    name: ${n}`,
          "    type: streamable_http",
          `    uri: ${url(port, n)}`,
          "    enabled: true",
          "    timeout: 300",
          "    headers:",
          `      Authorization: "Bearer <paste the token from ${tokenFile}>"`,
          `      X-Turno-Profile: ${profile}`,
        );
      }
      return {
        file: "~/.config/goose/config.yaml",
        text: `${lines.join("\n")}\n`,
        notes: ["Goose does not document variable expansion in headers: paste the token by hand and keep the file private (chmod 600)."],
      };
    }
    case "crush":
      return {
        file: "crush.json (project) or ~/.config/crush/crush.json",
        text: json({ mcp: each((n) => ({ type: "http", url: url(port, n), headers: headers(profile, "$TURNO_MCPD_TOKEN") })) }),
        notes: [TOKEN_ENV],
      };
    case "droid":
      return {
        file: "~/.factory/mcp.json",
        text: json({ mcpServers: each((n) => ({ type: "http", url: url(port, n), headers: headers(profile, "${TURNO_MCPD_TOKEN}") })) }),
        notes: [TOKEN_ENV, "Variable expansion in Droid headers is not verified: if the gateway answers 401, paste the token instead."],
      };
    case "kiro":
      return {
        file: "~/.kiro/settings/mcp.json",
        text: json({ mcpServers: each((n) => ({ url: url(port, n), headers: headers(profile, "${TURNO_MCPD_TOKEN}") })) }),
        notes: [TOKEN_ENV, "Variable expansion in Kiro headers is not verified: if the gateway answers 401, paste the token instead."],
      };
  }
}

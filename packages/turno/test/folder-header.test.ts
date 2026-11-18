import { describe, expect, it } from "vitest";
import { AGENT_IDS, type AgentId, adapter } from "../src/agents/index.js";
import { decodeCwdHeaders } from "../src/mcpd/gateway.js";

/** The launcher's environment for a session started in `cwd` (cli/launchers.ts). */
function launcherEnv(cwd: string): Record<string, string> {
  return {
    TURNO_SESSION_CWD_B64: Buffer.from(cwd, "utf8").toString("base64url").replace(/=+$/, ""),
    TURNO_SESSION_PID: "4242",
    TURNO_PROFILE: "work",
    TURNO_MCPD_TOKEN: "t",
  };
}

/** Headers as each agent sends them: its own variable syntax expanded from the environment. */
function sentHeaders(agent: AgentId, env: Record<string, string>): Record<string, string> {
  const e = adapter(agent).mcp.gatewayEntry("fx", 47821, "tok", "work");
  const expand = (v: string) =>
    v
      .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n: string) => env[n] ?? "")
      .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, n: string, d?: string) => env[n] ?? d ?? "");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((e.headers as Record<string, string>) ?? {})) out[k.toLowerCase()] = expand(v);
  for (const [k, v] of Object.entries((e.http_headers as Record<string, string>) ?? {})) out[k.toLowerCase()] = v;
  // Codex: env_http_headers maps a header to the name of a variable.
  for (const [k, v] of Object.entries((e.env_http_headers as Record<string, string>) ?? {}))
    out[k.toLowerCase()] = env[v] ?? "";
  return out;
}

describe("the session folder header", () => {
  it("every agent tells mcpd its folder, so folder rules apply to all four", () => {
    for (const agent of AGENT_IDS) {
      const cwd = "/Users/ana/código/日本/app";
      expect(decodeCwdHeaders(sentHeaders(agent, launcherEnv(cwd))), agent).toBe(cwd);
    }
  });

  it("without the launcher's variable the header is empty and mcpd falls back to the process folder", () => {
    for (const agent of AGENT_IDS) expect(decodeCwdHeaders(sentHeaders(agent, {})), agent).toBeUndefined();
    // A client that leaves an unset ${VAR} as it is sends text that is not base64url.
    expect(decodeCwdHeaders({ "x-turno-cwd-b64": "${TURNO_SESSION_CWD_B64}" })).toBeUndefined();
  });

  it("Copilot uses ${VAR} and Cursor ${env:VAR}, as each documents for headers", () => {
    expect(
      (adapter("copilot").mcp.gatewayEntry("fx", 1, "t", "w").headers as Record<string, string>)["X-Turno-Cwd-B64"],
    ).toBe("${TURNO_SESSION_CWD_B64}");
    expect(
      (adapter("cursor").mcp.gatewayEntry("fx", 1, "t", "w").headers as Record<string, string>)["X-Turno-Cwd-B64"],
    ).toBe("${env:TURNO_SESSION_CWD_B64}");
  });
});

import { assertIdentityId } from "./ids.js";

/** The mcp.toml block that serves one identity through mcpd (one session at a time). */
export function manifestSnippet(id: string): string {
  assertIdentityId(id);
  return [
    `[server.browser-${id}]`,
    `command = "turno-browser-mcp"`,
    `args = ["--identity", "${id}"]`,
    `scope = "shared"`,
    `exclusive = true`,
    `lease = "10m"`,
    `idle = "30m"`,
    "",
  ].join("\n");
}

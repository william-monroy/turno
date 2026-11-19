import { assertIdentityId } from "./ids.js";

/**
 * The mcp.toml block that serves one identity through mcpd. By default one agent session at a
 * time (`exclusive = true`); with `sharing: "tabs"` every session at once (`exclusive = false`),
 * each in its own tabs, which turno-browser locks (identity.json `"sharing": "tabs"`).
 */
export function manifestSnippet(id: string, options: { sharing?: "session" | "tabs" } = {}): string {
  assertIdentityId(id);
  const shared = options.sharing === "tabs";
  return [
    `[server.browser-${id}]`,
    `command = "turno-browser-mcp"`,
    `args = ["--identity", "${id}"]`,
    `scope = "shared"`,
    ...(shared
      ? ["exclusive = false  # every agent session at once, each in its own tabs"]
      : ["exclusive = true", `lease = "10m"`]),
    `idle = "30m"`,
    "",
  ].join("\n");
}

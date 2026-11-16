---
"turno-cli": minor
---

Each profile now has its own MCP gateway token, and servers can hide tools.

- `turno mcp sync` writes each profile's own token into its agent config (derived from the master token), and plain `claude` gets the system profile's. mcpd takes the profile from the token, not from the `X-Turno-Profile` header: a profile cannot open a server limited to other profiles, and a header that names another profile is refused.
- The master token in `mcpd.token` is no longer written into agent configs and only opens mcpd's own endpoints. **After upgrading, run `turno mcp sync` once**: configs synced by an older turno still send the master token, and mcpd refuses it for MCP sessions with a message that says so. `turno upgrade --finish` and `turno doctor` point it out too.
- Codex, Copilot and Cursor launchers read their profile's token from `~/.local/state/turno/mcpd-tokens/<profile>.token` (mode 600, written by `turno mcp sync`). `turno mcp config --agent <a> --profile <p>` points other agents at that file.
- `turno mcp token rotate` invalidates every profile token at once; run `turno mcp sync` afterwards.
- New `tools = { allow = [...], deny = [...] }` in `mcp.toml`, per server and per profile variant (glob patterns). Filtered tools are not listed and calls to them fail with a clear error. `turno config check` validates them.

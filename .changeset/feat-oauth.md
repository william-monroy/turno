---
"turno-cli": minor
---

mcpd can now log in to remote MCP servers that use OAuth, once per account, for every agent and profile.

- Declare a remote server with `auth = "oauth"` in `mcp.toml`. mcpd proxies it and adds the access token itself, so no agent logs in on its own. A profile that needs another account gets `[server.<name>.variant.<profile>]`; every other profile shares the default login.
- New `turno mcp login <server> [--profile p]`: finds the authorization server, registers turno (your own `client_id`, a client ID metadata document you host, or dynamic registration), and runs a PKCE login in the browser with a loopback redirect. `--no-browser` prints the link, `--dry-run` shows the plan, `--scope` asks for more scopes.
- New `turno mcp logout <server> [--profile p | --all]`: revokes the token at the server when it can and deletes it.
- Tokens are kept only in the Keychain or Secret Service (`turno/oauth/<server>@<variant>`), never in files or logs. mcpd refreshes them when they expire or the server answers 401, and saves a rotated refresh token before using the new access token; if the Keychain refuses that write, mcpd keeps the token in memory and retries instead of losing it.
- When a login is missing or was revoked, calls fail with the `turno mcp login` command to run, and `turno mcp list`, `turno mcp doctor` and `turno doctor` show it.

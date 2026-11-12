# MCP servers behind mcpd

Every profile's `.claude.json` lists local MCP servers as HTTP entries pointing at mcpd:

```json
"calendar": {
  "type": "http",
  "url": "http://127.0.0.1:47821/mcp/calendar",
  "headers": {
    "Authorization": "Bearer <token>",
    "X-Turno-Profile": "work",
    "X-Turno-Pid": "${TURNO_SESSION_PID:-0}",
    "X-Turno-Cwd": "${PWD:-}"
  }
}
```

`turno mcp sync` writes these. Claude Code expands the `${...}` values when it connects, so
mcpd learns which session (launcher PID) and folder each connection comes from.

## mcp.toml reference

```toml
[server.<name>]
command = "server-bin"            # stdio server
args = ["--flag"]
env = { TOKEN = "keychain:turno/name/token", REGION = "eu", OTHER = "env:SOME_VAR" }
cwd = "/abs/path"                 # default: project root (project), session folder (session), home (shared)
package = "server-pkg@1.2.3"      # optional: `turno mcp install` pins it; until then npx runs it
scope = "shared"                  # shared | project | session (default shared)
idle = "30m"                      # stop after this long without calls (default 30m shared, 20m others)
exclusive = false                 # one client session at a time (shared scope only)
lease = "5m"                      # exclusive: how long an idle holder keeps it
profiles = ["*"]                  # which profiles get this server

[server.<name>.variant.<profile>] # what changes for one profile (a different account)
env = { TOKEN = "keychain:turno/name/token-work" }

[server.<remote>]
url = "https://example.com/mcp"
headers = { Authorization = "keychain:turno/remote/auth" }   # secret headers: proxied by mcpd
```

Values starting with `keychain:` are read with `security find-generic-password -s <service> -w`
when the server starts; `env:` reads mcpd's own environment. Store a secret with
`turno secret set <service>` (input is hidden, never printed).

## Choosing a scope

| Scope | One process per | Use it for |
|---|---|---|
| `shared` | server and variant | stateless API clients, indexes that cover every repository |
| `project` | git repository of the session | servers that read their working folder |
| `session` | Claude session | servers that drive a browser or keep per-conversation state |

A remote server without secret headers is written straight into each profile and never touches
mcpd. With secret headers it is proxied, so the secret stays in the Keychain.

## What the gateway does

- Answers `initialize` and the `*/list` methods from a cache, so a session that never calls a
  tool never starts the server.
- Starts the upstream on the first real call, relays requests, notifications, progress,
  cancellation, and server-to-client requests (roots, elicitation) to the session that made the
  call.
- Stops instances idle for longer than `idle`, and session instances whose launcher PID died.
- Reloads `mcp.toml` when it changes (or on SIGHUP) and restarts only servers whose definition
  changed.

## Plugin servers

Servers that come from Claude Code plugins start in every session and bypass mcpd.
`turno mcp doctor` lists them. To route one through mcpd, disable the plugin and declare
`[server.plugin_<plugin>_<name>]` so tool names stay the same.

## Troubleshooting

```sh
turno mcp daemon status    # running servers, clients, memory (turno mcpd works too)
turno mcp daemon logs -n 100  # gateway log
ls ~/.local/state/turno/logs/   # one stderr log per server (and variant)
turno mcp refresh <name>   # forget a cached tool list
```

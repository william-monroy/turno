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
    "X-Turno-Cwd-B64": "${TURNO_SESSION_CWD_B64:-}"
  }
}
```

`turno mcp sync` writes these. Claude Code expands the `${...}` values when it connects, so
mcpd learns which session (launcher PID) and folder each connection comes from. The launcher
exports the folder base64url-encoded, because a raw path outside Latin-1 (an accent typed in
NFD form, CJK, an emoji) is not a valid header value and the client would refuse to connect.
Without the variable (a plain `claude`), mcpd reads the folder of the client process (`/proc`
on Linux, `lsof` on macOS). Entries written by older versions still send `X-Turno-Cwd`; mcpd
keeps reading it.

## mcp.toml reference

```toml
[server.<name>]
command = "server-bin"            # stdio server
args = ["--flag"]
env = { TOKEN = "keychain:turno/name/token", REGION = "eu", OTHER = "env:SOME_VAR" }
cwd = "/abs/path"                 # default: project root (project), session folder (session), home (shared)
package = "server-pkg@1.2.3"      # optional: `turno mcp install` pins it to an exact version; until then npx runs it (with a warning in the logs)
scope = "shared"                  # shared | project | session (default shared)
idle = "30m"                      # stop after this long without calls (default 30m shared, 20m others;
                                  # a session server stays while its session's process lives)
call_timeout = "10m"              # optional: cancel a single request that runs longer (off by default;
                                  # it also cuts calls waiting for the user to answer a form)
exclusive = false                 # one client session at a time (shared scope only)
lease = "5m"                      # exclusive: how long an idle holder keeps it
profiles = ["*"]                  # which profiles get this server

[server.<name>.variant.<profile>] # what changes for one profile (a different account)
env = { TOKEN = "keychain:turno/name/token-work" }

[server.<remote>]
url = "https://example.com/mcp"
headers = { Authorization = "keychain:turno/remote/auth" }   # secret headers: proxied by mcpd
type = "http"                     # or "sse" for the legacy HTTP+SSE transport
```

Values starting with `keychain:` are read with `security find-generic-password -s <service> -w`
when the server starts; `env:` reads mcpd's own environment, and `env:NAME:-default` uses the
default when `NAME` is unset or empty. Under the LaunchAgent mcpd sees few variables (set more
with `launchctl setenv`), so prefer `keychain:` for secrets. Store a secret with
`turno secret set <service>` (input is hidden, never printed).

## Importing what you already have

`turno mcp import` drafts `mcp.toml` from the servers your agents already use: user and project
servers in `~/.claude.json`, `.mcp.json` in the current folder, `~/.codex/config.toml`,
`~/.cursor/mcp.json` and `~/.copilot/mcp-config.json`. It is a preview until `--write`: secrets
are shown masked and nothing is stored. `--write --move-secrets` stores env and header secrets
in the Keychain and writes `keychain:` references; secrets in args or URLs stay literal (they
cannot come from the Keychain). `${VAR}` and `${VAR:-default}` become `env:VAR` and
`env:VAR:-default`.

`turno mcp install` then resolves each `package` to an exact version, rewrites it in
`mcp.toml`, installs it without install scripts (`--allow-scripts` to run them) and keeps a
`package-lock.json` in `~/.local/share/turno/servers/<name>/`, so a reinstall gets the same
files.

## Choosing a scope

| Scope | One process per | Use it for |
|---|---|---|
| `shared` | server and variant | stateless API clients, indexes that cover every repository |
| `project` | git repository of the session | servers that read their working folder |
| `session` | Claude session | servers that drive a browser or keep per-conversation state |

A remote server without secret headers is written straight into each profile and never touches
mcpd. With secret headers it is proxied, so the secret stays in the Keychain.

## What the gateway does

- Answers `initialize`, `tools/list`, `prompts/list` and `resources/templates/list` from a
  cache, so a session that never calls a tool never starts the server. `resources/list` always
  reaches a running instance, since resources differ per project.
- Starts the upstream on the first real call and relays requests, notifications, progress and
  cancellation. Every start lists the tools again; when they changed, the cache is updated and
  clients get `list_changed`.
- Relays elicitation and sampling to the session whose call is in flight, and only offers them
  to the server when the client supports them. When calls from several sessions are in flight on
  a shared server, it refuses the request instead of guessing (use `scope = "session"` or
  `exclusive = true` for servers that ask the user). `roots/list` is answered by mcpd from the
  project or session folder; shared servers are not offered roots.
- Cancels a call upstream when the client cancels it or goes away, so an interrupted tool does
  not keep the server alive.
- Stops instances idle for longer than `idle`, session instances whose launcher PID died, and
  instances whose definition changed in `mcp.toml`. Open sessions use the new definition on
  their next call.
- After 3 failed starts in a row, answers at once with the last lines of the server's log and
  retries with a growing delay (5 s, doubling, up to 5 minutes).
- Rebuilds a session it does not know (mcpd restarted) from the request headers instead of
  answering 404.
- Reloads `mcp.toml` when it changes (or on SIGHUP).

`POST /refresh/<server>` (or `POST /refresh` for all servers) on the gateway, with the bearer
token, relists running instances and forgets the cached description of the others, without a
restart. It answers `{"server", "refreshed": [...], "forgotten": [...], "errors": {...}}`.

## Plugin servers

Servers that come from Claude Code plugins start in every session and bypass mcpd.
`turno mcp doctor` lists them. To route one through mcpd, disable the plugin and declare
`[server.plugin_<plugin>_<name>]` so tool names stay the same.

## Troubleshooting

```sh
turno mcp daemon status    # running servers, clients, memory; or why mcpd is down
turno mcp daemon logs -n 100  # gateway log, in local time (--utc for the raw lines)
ls ~/.local/state/turno/logs/   # one stderr log per server (and variant)
turno mcp refresh <name>   # forget a cached tool list; a running mcpd relearns it
```

## The daemon as a service

`turno mcp daemon start` keeps mcpd alive with a LaunchAgent on macOS
(`~/Library/LaunchAgents/dev.turno.mcpd.plist`) or a `systemd --user` unit on Linux
(`~/.config/systemd/user/turno-mcpd.service`). `--dry-run` prints the file first; the write is
journaled, so `turno undo` restores it. `turno mcp daemon stop` stops mcpd and removes the
file, so it does not come back at login. `turno upgrade --finish` rewrites the file and restarts
mcpd for the new version.

mcpd listens only on `mcpd.port` (config.toml, default 47821). If something else holds that
port, mcpd does not move: it fails and names the owner, and `turno doctor` says the same. Pick
another port with `turno config set mcpd.port <port>`, then `turno mcp sync`.

If `mcp.toml` stops validating, mcpd keeps serving the last copy that did
(`~/.local/state/turno/mcp.last-good.toml`) and reports the error in `turno mcp daemon status`
and `turno doctor`.

`turno mcp token rotate` replaces the gateway token, restarts mcpd and asks you to run
`turno mcp sync`. See [ADR 0017](decisions/0017-daemon-service-port-and-last-good-manifest.md).

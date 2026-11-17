# MCP servers behind mcpd

Every profile's `.claude.json` lists local MCP servers as HTTP entries pointing at mcpd:

```json
"calendar": {
  "type": "http",
  "url": "http://127.0.0.1:47821/mcp/calendar",
  "headers": {
    "Authorization": "Bearer <the work profile's token>",
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

## Tokens and profiles

Each profile gets its own gateway token, derived from the master token in
`~/.local/state/turno/mcpd.token` (HMAC-SHA256, so mcpd keeps no list of them). mcpd reads the
profile from the token, not from `X-Turno-Profile`: a session with the `work` token cannot open
a server whose `profiles` leave `work` out (HTTP 403), and a request whose `X-Turno-Profile`
names another profile than its token is refused too. Plain `claude` gets the token of the
system profile. Codex, Copilot and Cursor read the token from `TURNO_MCPD_TOKEN`, which their
launcher fills from `~/.local/state/turno/mcpd-tokens/<profile>.token` (mode 600, written by
`turno mcp sync`).

The master token never goes into an agent config. It opens only mcpd's own endpoints
(`/status`, `/refresh`), which `turno` uses; mcpd refuses it for MCP sessions. Configs synced by
a turno older than per-profile tokens still send it: mcpd answers 403 with "run: turno mcp sync",
and `turno doctor` and `turno upgrade --finish` say the same. Removing a profile does not revoke
its token; `turno mcp token rotate` does (for every profile). See
[ADR 0023](decisions/0023-per-profile-gateway-tokens-and-tool-filters.md).

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
profiles = ["*"]                  # which profiles get this server (and may open it)
tools = { allow = ["get_*", "list_*"], deny = ["*_delete"] }   # optional: which tools sessions see

[server.<name>.variant.<profile>] # what changes for one profile (a different account)
env = { TOKEN = "keychain:turno/name/token-work" }
tools = { deny = ["*"] }          # replaces the server's allow / deny, key by key, for this profile

[server.<remote>]
url = "https://example.com/mcp"
headers = { Authorization = "keychain:turno/remote/auth" }   # secret headers: proxied by mcpd
type = "http"                     # or "sse" for the legacy HTTP+SSE transport
auth = "oauth"                    # instead of an Authorization header: mcpd logs in (see below)
```

`tools` patterns match whole tool names: `*` is any run of characters, `?` one character. With
`allow`, only matching tools stay; `deny` then removes matching ones. A filtered tool is absent
from `tools/list`, and a call to it gets a JSON-RPC error. mcpd applies the filter, so it works
for stdio servers and proxied remotes, and `turno config check` refuses it on a remote that does
not go through mcpd.

Values starting with `keychain:` are read with `security find-generic-password -s <service> -w`
when the server starts; `env:` reads mcpd's own environment, and `env:NAME:-default` uses the
default when `NAME` is unset or empty. Under the LaunchAgent mcpd sees few variables (set more
with `launchctl setenv`), so prefer `keychain:` for secrets. Store a secret with
`turno secret set <service>` (input is hidden, never printed).

Inside other values, mcpd expands `${NAME}`, `${NAME:-default}` and `${env:NAME}` from its own
environment, as Claude Code does in its config: in a stdio server's `args` and `env` values and
in a proxied server's headers (`"--region=${REGION}"`, `"Bearer ${API_TOKEN}"`). A variable
that is unset and has no default stops that server from starting with an error that names it.
Cursor's placeholders such as `${workspaceFolder}` are left as written.

## Remote servers with OAuth

A remote server that asks its users to log in (Linear, Notion, GitHub and most hosted MCP
servers) can be declared with `auth = "oauth"`. mcpd then becomes its OAuth client: you log in
once per account with `turno mcp login`, and every agent and profile reaches the server through
mcpd without a login of its own. See [ADR 0029](decisions/0029-oauth-for-remote-servers.md).

```toml
[server.linear]
url = "https://mcp.linear.app/mcp"
auth = "oauth"

[server.linear.variant.personal]  # this profile logs in with another account
                                  # (optional key: tools)

[server.linear.oauth]             # all optional
scope = "read write"              # instead of what the server asks for
client_id = "abc123"              # a client you registered by hand (pre-registration)
client_secret = "keychain:turno/linear/client-secret"   # its secret, only as a reference
callback_port = 33418             # fixed loopback port, when the client was registered with one
client_metadata_url = "https://example.com/turno-client.json"   # a Client ID Metadata Document you host
authorization_server = "https://auth.example.com"   # when the server lists several
```

```sh
turno mcp login linear                    # the login every profile without a variant uses
turno mcp login linear --profile personal # the personal variant
turno mcp login linear --no-browser       # print the link instead of opening the browser
turno mcp login linear --dry-run          # discovery and registration plan, nothing stored
turno mcp logout linear [--profile p | --all] [--no-revoke]
```

`turno mcp login` finds the authorization server from the server's protected resource metadata,
registers turno (a hand-registered `client_id` first, then a Client ID Metadata Document when
you host one and the server supports it, then dynamic client registration), opens the browser
on a PKCE authorization request, and waits for the answer on `http://127.0.0.1:<port>/callback`.
It refuses authorization servers that do not advertise PKCE with S256, metadata whose `issuer`
is not the one it was fetched for, and answers whose `iss` or `state` does not match.

The tokens go to the secret store (Keychain or Secret Service) as `turno/oauth/<server>@<variant>`,
never to a file or a log. mcpd refreshes the access token when it expires or the server answers
401, and saves a rotated refresh token before it uses the new access token. If the secret store
refuses that write, mcpd keeps the new tokens in memory, tries the write again on each call,
and notes it in `logs/<server>.log`; a `turno mcp login` or `logout` made meanwhile wins. When
the authorization server rejects the refresh token (revoked or expired), calls fail with the
`turno mcp login` command to run, and `turno mcp list`, `turno mcp doctor` and `turno doctor`
show the variant as "login required". After a logout, mcpd stops using the old access token
within a minute.

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
  their next call. When memory is tight (the kernel pressure level on macOS, PSI on Linux, else
  free memory), the idle limit shrinks to `idle_under_pressure` under `[mcpd]` in config.toml
  (default `"5m"`, a quarter of it when pressure is critical, `false` turns it off). A session
  server whose launcher still runs is kept either way.
- Speaks two MCP revisions on the same endpoint: 2025-11-25 sessions (`initialize`,
  `Mcp-Session-Id`) and 2026-07-28 stateless requests (`MCP-Protocol-Version: 2026-07-28`,
  `Mcp-Method` and `Mcp-Name` headers, `server/discover`, `subscriptions/listen`). List results
  for 2026-07-28 clients carry `ttlMs` (5 minutes once a running server confirmed the list since
  mcpd started, else 0) and `cacheScope = "private"`. Servers behind mcpd are still spoken to as
  2025-11-25. A 2026-07-28 client cannot answer elicitation or sampling through mcpd yet; see
  [ADR 0028](decisions/0028-mcp-2026-07-28-and-memory-pressure-idle.md).
- After 3 failed starts in a row, answers at once with the last lines of the server's log and
  retries with a growing delay (5 s, doubling, up to 5 minutes).
- Rebuilds a session it does not know (mcpd restarted) from the request headers instead of
  answering 404.
- Reloads `mcp.toml` when it changes (or on SIGHUP).

`POST /refresh/<server>` (or `POST /refresh` for all servers) on the gateway, with the master
token, relists running instances and forgets the cached description of the others, without a
restart. It answers `{"server", "refreshed": [...], "forgotten": [...], "errors": {...}}`.

## Watching the gateway

```sh
turno mcp log                 # the last 20 tool calls: time, outcome, duration, server, tool, profile, agent, sizes
turno mcp log -f --server github --profile work   # follow new calls, filtered
turno mcp log --json -n 500   # one JSON record per line, for jq
turno mcp top                 # memory, sessions, calls in flight, idle time and restarts per running server
turno mcp savings             # mcpd's memory now against the same sessions without the gateway
```

mcpd appends one JSON line per tool call it relays to `~/.local/state/turno/logs/calls.jsonl`
(mode 600, rotated at 5 MiB, two old files kept):

```json
{"time":"2026-11-16T21:00:00.000Z","agent":"claude-code","profile":"work","pid":4242,"server":"github","variant":"work","tool":"create_issue","durationMs":812,"outcome":"ok","requestBytes":431,"responseBytes":2210}
```

`outcome` is `ok`, `error`, `cancelled` or `timeout`; failed calls add `error`, with anything
that looks like a token replaced by `[redacted]`. A record never holds the call's arguments or
its result, only their sizes. `agent` is the name the client gives in `initialize`. Turn the log
off with `call_log = false` under `[mcpd]` in config.toml (it applies at the next mcpd start).

`turno mcp top` refreshes every 2 seconds in a terminal and prints one snapshot with `--once`,
`--json` or when piped. Memory is the resident size of each server process plus its children
(`npx` and shell wrappers start the real server as a child), read with `ps`, or from `/proc` on
Linux hosts without it.

`turno mcp savings` compares mcpd plus every server it runs now with an estimate of the same
live agent sessions without the gateway: each session would start its own copy of every stdio
server its profile uses, so the estimate is sessions x per-server memory. A server that is not
running now counts with the memory mcpd measured the last time it ran (mcpd samples every 15
seconds while servers run and keeps the numbers in `~/.local/state/turno/mcpd-rss.json`).
Resident memory counts shared pages once per process, so both sides overcount a little in the
same way. See [ADR 0026](decisions/0026-call-log-top-and-savings.md).

## Plugin servers

Servers that come from Claude Code plugins start in every session and bypass mcpd.
`turno mcp doctor` lists them. To route one through mcpd, disable the plugin and declare
`[server.plugin_<plugin>_<name>]` so tool names stay the same.

## Troubleshooting

```sh
turno mcp daemon status    # running servers, clients, memory; or why mcpd is down
turno mcp daemon logs -n 100  # gateway log, in local time (--utc for the raw lines)
turno mcp log --server <name>  # its recent tool calls, with errors and durations
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

mcpd refuses request bodies over 32 MiB. Raise or lower that with
`turno config set mcpd.max_request_body 64MiB` (between 1MiB and 1GiB) and restart mcpd.

If `mcp.toml` stops validating, mcpd keeps serving the last copy that did
(`~/.local/state/turno/mcp.last-good.toml`) and reports the error in `turno mcp daemon status`
and `turno doctor`.

`turno mcp token rotate` replaces the master token, which invalidates every profile token,
restarts mcpd and asks you to run `turno mcp sync`. See [ADR 0017](decisions/0017-daemon-service-port-and-last-good-manifest.md).

`turno doctor --security` checks the rest of the posture: who can read turno's folders (and
narrows them with `--fix`), who holds the mcpd port, literal secrets left in `mcp.toml`, agent
configs and backups, servers that run whatever version is newest, the age of the token and the
audit log's hash chain. See [ADR 0027](decisions/0027-security-doctor-and-variable-expansion.md).

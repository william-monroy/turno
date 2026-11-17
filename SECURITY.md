# Security policy

## Reporting a vulnerability

Report it privately through GitHub: **Security > Report a vulnerability** on this repository
(private vulnerability reporting). That is the only channel; please do not open a public issue,
discussion or pull request for a vulnerability.

What to include: the version (`turno version`), OS, the component (CLI, gateway, status line,
accounts bridge, browser), steps to reproduce, and the impact you see. Remove tokens, Keychain
values and personal paths from logs before you send them.

What to expect:

| Step | Target |
|---|---|
| Acknowledgement | 3 working days |
| Triage and severity | 7 days |
| Fix for high and critical issues | 30 days |
| Coordinated disclosure | at most 90 days after the report, earlier once a fix ships |

Fixed issues get a GitHub security advisory and, where it applies, a CVE requested through
GitHub. Reporters are credited unless they ask not to be.

**Reports written with AI tools** are welcome if you say so in the report, you have verified the
finding yourself, and the proof of concept is real. Invented or unverified findings waste the
maintainer's time; reporters who send them repeatedly are blocked.

## Supported versions

During 0.x only the latest minor release gets security fixes. Upgrade with `turno upgrade`.

## Security model

turno runs on your machine, as your user, and handles credentials of several accounts. This
is what it stores, what it trusts, and what it does not protect against.

### What turno stores

| Data | Where | Protection |
|---|---|---|
| Agent logins (one per profile) | each agent's own config dir, e.g. `~/.claude-<profile>` | written by the agent itself; turno never reads, copies or proxies them |
| MCP server secrets | macOS Keychain or Linux Secret Service (`secret-tool`), items `turno/<server>/<key>` | read at use time, passed on stdin (never in a command line), never logged |
| OAuth tokens of remote MCP servers | the same secret store, items `turno/oauth/<server>@<variant>` | never in a file or a log; refreshed by mcpd and sent only to that server's own origin |
| Master gateway token | `~/.local/state/turno/mcpd.token` | file mode 600; used by turno only, for mcpd's own endpoints; never written into an agent config |
| Per-profile gateway tokens | each profile's agent config (`.claude.json` for Claude Code), and `~/.local/state/turno/mcpd-tokens/<profile>.token` for the launchers of Codex, Copilot and Cursor | file mode 600; each one holds that profile's own token, derived from the master token |
| Browser identities | `~/.local/share/turno/browser/<identity>` | live cookies of the sites you signed into: treat as credentials |
| Chrome profiles for `turno open` | `~/.local/share/turno/chrome/<profile>` | the claude.ai session of each profile |
| Installed MCP servers | `~/.local/share/turno/servers/<name>/` | folders mode 700; exact versions, no install scripts unless `--allow-scripts` |
| Usage, run records, exhausted marks, logs, caches, `mcpd-clients.json` | `~/.local/state/turno/` | folders 0700, files 0600; no secrets |
| Tool call log | `~/.local/state/turno/logs/calls.jsonl` | mode 600; tool names, profiles, agents, durations, sizes and redacted errors, never arguments or results; `call_log = false` under `[mcpd]` turns it off |
| Backups of the files turno changes | `~/.local/state/turno/backups/` | folders 0700, files 0600; they can hold literal secrets that were in those files; pruned after 30 days, keeping the newest 10 (`turno undo --prune` by hand) |
| Accounts bridge audit log | `~/.local/state/turno/audit.jsonl` (mode 600) | append-only and hash-chained; prompts, results and the policy decision of each delegated task |

`turno mcp import` shows secrets masked and stores nothing until `--write`. With
`--move-secrets` it moves env and header secrets to the secret store; secrets in a server's
args or URL query string stay literal in `mcp.toml`, since they cannot come from the store.

turno does not intercept, store or forward model traffic, and it does not handle the OAuth
tokens of Claude, ChatGPT, GitHub or any other vendor's agent login. Each agent logs in by
itself, in its own config directory.

### The gateway (`mcpd`)

- Listens on `127.0.0.1` only, never on a public interface, and only on `mcpd.port`: if
  another process holds that port, mcpd fails and names it instead of moving.
- Requires a bearer token on every request. Each profile has its own token, and the token
  decides the profile, so which servers (`profiles`) and tools (`tools` allow and deny) a
  session reaches. The master token opens only mcpd's own endpoints (`/status`, `/refresh`)
  and is refused for MCP sessions. `turno mcp token rotate` replaces it and so invalidates
  every profile token. mcpd does not pass any token it receives on to the MCP servers behind
  it (each server gets its own secrets from the secret store).
- Rejects any request that carries an `Origin` header, so a web page in your browser cannot
  reach it (DNS rebinding and cross-site requests), and request bodies over
  `mcpd.max_request_body` (32 MiB by default).
- Runs MCP servers as your user, with the commands you put in `mcp.toml`. A server you add is
  code you trust; the gateway does not sandbox it.
- Is the OAuth client of `auth = "oauth"` remote servers: it logs in once per account with
  PKCE, refuses authorization servers without S256 and answers whose issuer or state does not
  match, and never presents a token to another server
  ([ADR 0029](docs/decisions/0029-oauth-for-remote-servers.md)).
- Folder server sets (`mcp`, `mcp_deny` in `config.toml`) hide servers from sessions in a
  folder; they are a convenience, not a boundary: a session whose folder mcpd cannot learn
  sees every server.

### The accounts bridge

A delegated task runs headless in the profile that owns the account. A read gets only the
account's `read_tools`, and Claude Code refuses every other tool. An account without
`read_tools`, and by default every call to a mail or messaging account, asks for your
confirmation in the client, as writes do. The run loads no settings files, starts in turno's
own empty folder with a minimal environment, and gets only the account's MCP servers when
they go through the gateway. Every call, with the decision (policy, confirmation, allowed
tools), is written to the audit log (`turno identity log`). Details:
[docs/accounts.md](docs/accounts.md).

### The browser package

`turno-browser-mcp` serves over stdio, through mcpd. It refuses `--port` or `--host` together with
`--identity`, which would serve a signed-in browser over HTTP, unless you pass
`--allow-http-identity`; it then listens on 127.0.0.1 only.

### Checking your setup

`turno doctor --security` checks who can read or write turno's folders (`--fix` narrows them
to owner only), who holds the mcpd port, literal secrets left in `mcp.toml`, agent configs and
backups (it names where, never the value), MCP servers that do not run an exact version, the
age of the gateway token (and profile token files older than it), and the audit log's hash
chain.
`turno identity log --verify` checks the hash chain alone and exits 1 when it is broken.

### Out of scope

- Anything another process running as your user can do: it can read the token files, the
  browser profiles and the agent config dirs. turno does not defend against local malware.
- The behavior of the agents and the MCP servers themselves.
- How you use the browser on third-party sites: that is between you and each site's terms.

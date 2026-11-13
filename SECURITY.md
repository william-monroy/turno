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
| MCP server secrets | macOS Keychain, items `turno/<server>/<key>` | read at use time, never logged, never written to disk |
| Gateway bearer token | `~/.local/state/turno/mcpd.token` | file mode 600 |
| Profile MCP entries | each profile's agent config (`.claude.json` for Claude Code) | file mode 600; they hold the gateway token, since the agent sends it as a header |
| Browser identities | `~/.local/share/turno/browser/<identity>` | live cookies of the sites you signed into: treat as credentials |
| Chrome profiles for `turno open` | `~/.local/share/turno/chrome/<profile>` | the claude.ai session of each profile |
| Usage, run records, exhausted marks, logs, backups | `~/.local/state/turno/` | no secrets |
| Accounts bridge audit log | `~/.local/state/turno/audit.jsonl` (mode 600) | prompts and results of delegated tasks |

turno does not intercept, store or forward model traffic, and it does not handle the OAuth
tokens of Claude, ChatGPT, GitHub or any other vendor. Each agent logs in by itself, in its own
config directory.

### The gateway (`mcpd`)

- Listens on `127.0.0.1` only, never on a public interface.
- Requires the bearer token on every request; it does not pass that token, or any token it
  receives, on to the MCP servers behind it (each server gets its own secrets from the
  Keychain).
- Rejects any request that carries an `Origin` header, so a web page in your browser cannot
  reach it (DNS rebinding and cross-site requests).
- Runs MCP servers as your user, with the commands you put in `mcp.toml`. A server you add is
  code you trust; the gateway does not sandbox it.

### The accounts bridge

A delegated task runs headless in the profile that owns the account, with only that account's
tools allowed. Tasks that write need your confirmation in the client. Every call is written to
the audit log (`turno identity log`). The read-only promise for "read" tasks is enforced by the
prompt, not by tool patterns yet (see `docs/STATUS.md`).

### Out of scope

- Anything another process running as your user can do: it can read the token file, the
  browser profiles and the agent config dirs. turno does not defend against local malware.
- The behavior of the agents and the MCP servers themselves.
- How you use the browser on third-party sites: that is between you and each site's terms.

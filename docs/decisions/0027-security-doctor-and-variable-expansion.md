# 0027. A security doctor, `${VAR}` expansion in mcpd, and a configurable body limit

Date: 2026-11-16. Status: accepted.

## Context

Wave 1 (ADRs 0016 to 0022) made turno's files private, moved secrets out of argv, chained the
audit log and stopped the gateway from moving ports. What was missing was a way to see that
posture on a given machine, and three loose ends:

- The checks existed in pieces (`turno doctor` looked at the token mode and the port owner,
  `verifyAudit()` had no command) and nothing looked for literal secrets left in agent configs
  and backups, or for MCP servers that download whatever version is newest at each start.
- mcpd passed `${VAR}` inside a stdio server's args and env values, and inside a proxied
  server's headers, as written: a server got the literal text `--region=${REGION}`. Claude
  Code expands those in its own config, so a server moved behind mcpd broke silently.
- The gateway's request body limit (32 MiB, above the SDK's 4 MiB) could not be changed.

## Decision

**`turno doctor --security`** runs a separate set of read-only checks (it does not run the
other doctor checks; `turno doctor` stays as fast as before and only gains a "secret store"
line):

- *Secret store*: which one resolves `keychain:` references (macOS Keychain or Secret
  Service). None is a failure only when `mcp.toml` uses `keychain:`.
- *Permissions*: every folder and file under the config, state and data roots, without
  following links. Group or other bits are a warning (read) or a failure (write); an item owned
  by another user is a warning (usually a `sudo turno`). The contents of npm installs
  (`servers/`, any `node_modules`) and Chrome profiles are not walked: their owners set those
  modes and the 0700 root already covers them. The walk stops after 20,000 entries. `--fix`
  removes group and other bits (`chmod go-rwx`) from what it found; nothing else is changed.
- *mcpd port*: the port is held by mcpd under this user (ok), by nobody (info), by another
  process of this user that does not answer as mcpd (warn), or by another user (fail): in the
  last two cases sessions would send that process the gateway token.
- *Literal secrets*: `mcp.toml` (variants included), the agents' own configs (`~/.claude.json`,
  Codex, Cursor and Copilot) and every profile's MCP file, and the copies in journal backups.
  Detection is the importer's (`isSecretValue`, `argSecrets`, `urlSecrets`). Gateway entries are
  skipped: their bearer is the gateway token, which has its own check. Only the place is
  printed (`linear.headers.Authorization`), never the value.
- *Versions*: a `package` that is not one exact version, and `npx`, `bunx`, `pnpm dlx` or `uvx`
  launches without one, are warnings; an exact `package` that is not installed (npx fetches it
  at each start) is info.
- *Token age*: a master token older than 90 days gets a rotation hint. 90 days is a habit, not
  a cryptographic limit: the token never leaves the machine, but it is copied into every synced
  Claude Code profile config and its backups, and rotating is one command.
- *Audit log*: `verifyAudit()`; a broken chain fails the run.

Exit code 1 when a check fails, as for `turno doctor`; `--json` gives the same shape.

**`turno identity log --verify`** (and `turno accounts log --verify`) prints the result of
`verifyAudit()` and exits 1 on a broken chain. `log --json` lists the entries.

**`${VAR}` expansion.** `expandVars()` in `core/secrets.ts` expands `${NAME}`,
`${NAME:-default}` (shell semantics: unset or empty) and Cursor's `${env:NAME}` anywhere in a
string, from mcpd's environment. mcpd applies it to stdio args and env values and to the headers
of proxied remote servers, after the whole-value references (`keychain:`, `env:`) are resolved.
An unset variable without a default is a `SecretError` naming it, so the server does not start
with a half-empty credential. `${workspaceFolder}` and the other editor placeholders stay as
written. Whole-value `keychain:` and `env:` keep their meaning and are not looked for inside
strings: a value is either a reference or text. The importer's notes now say mcpd expands mixed
values, and still recommend the secret store for secrets, since under the LaunchAgent mcpd only
sees variables set with `launchctl setenv`.

**`[mcpd] max_request_body`** in `config.toml`: bytes, or a size such as `"64MiB"`, between
1 MiB and 1 GiB; unset keeps 32 MiB. It is read when mcpd starts. Out of range is a config
error, which mcpd treats as for any broken `config.toml` (defaults, error shown in `/status`).

## Consequences

- One command answers "is this install in a sane state?" for a security review or a bug
  report. It reads agent configs and backups, which may be large; it never prints secrets.
- `turno doctor --security --fix` is the way to narrow files written by turno 0.1, which used
  the umask. Files turno writes from now on (logs, marks, caches, the managed list, the update
  and version stamps, `mcpd.port`, `mcpd.error.json`) are created 0600 in 0700 folders, as
  ADR 0018 intended.
- A server whose args used `${VAR}` and happened to work because it ignored the text now gets
  the value, or fails to start when the variable is missing. The error names the variable.
- Per-profile gateway tokens are not checked for age yet; when they land, their age check
  belongs next to the master token's.

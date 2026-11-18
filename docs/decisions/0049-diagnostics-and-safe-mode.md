# 0049. Diagnostics: `turno mcp call`, `doctor --report`, safe mode, and the folder header for every agent

Date: 2026-11-18. Status: accepted. Builds on ADR 0013 (agent adapters), ADR 0031 (server sets
per folder), ADR 0032 (the agent registry) and ADR 0045 (the output contract and exit codes).

## Context

When something goes wrong inside an agent session, the question is first whether turno is the
cause. Four gaps made that slow to answer:

- **A server could only be tried from an agent.** To see which tools a profile's session gets
  from mcpd in a folder, or what a tool returns, you had to open an agent and ask it. Tool
  filters, profile variants and folder server sets made the answer depend on profile and folder.
- **Bug reports asked for five commands.** turno version, Node, OS, each agent's version, mcpd's
  state and the doctor output had to be gathered by hand, and pasted doctor output carried home
  paths. Nothing listed every path turno writes.
- **There was no way to run an account without the gateway.** The launcher always exports the
  gateway token and session headers, and the profile's config always holds the gateway entries,
  so "does it happen without turno?" meant editing config files.
- **Folder server sets applied only to Claude Code and Codex.** Their gateway entries send the
  session folder in `X-Turno-Cwd-B64`; the Copilot CLI and Cursor CLI entries did not, so mcpd
  fell back to the folder of the client process (`lsof` / `/proc`), which is slower and fails
  for processes it cannot inspect.

## Decision

### `turno mcp call <server> [tool]`

The CLI connects to mcpd as a session would: the profile's token (`--profile`, else the profile
the current folder resolves to, else `system`, else `default`), `X-Turno-Profile`, its own PID and
the current folder in `X-Turno-Cwd-B64`. Everything mcpd applies to an agent (tool filters,
variants, server sets) applies to the call. Without a tool it lists the tools. `--args` takes a
JSON object and `--arg k=v` / `--arg k:=json` add to it. `--json` returns the result with
`schemaVersion`. A hidden server, an unknown tool or an `isError` result exit 1; mcpd down exits 5
(`gateway_down`). Remote servers that agents reach directly are refused: they never pass mcpd.

### `turno doctor --report` and `turno config path --all`

`--report` runs the same checks and prints one Markdown block: versions (turno and install
method, Node, OS, shell, terminal), config state, profile counts by agent, each agent's path and
`--version` (3 s limit), mcpd's `/status` summary, the doctor counts with every warning and
failure and its fix, and a collapsed table of paths. Paths are shown with `~`; tokens, secret
values and variable values are never read into it (doctor findings already name secrets by key).
It does not combine with `--json`, `--summary` or `--fix` (exit 2). The issue template asks for
it. `turno config path --all` lists the same paths, with what turno keeps in each and whether it
exists (`all` in `--json`).

### Safe mode: `--no-gateway` and `TURNO_SAFE=1`

`turno run <p> --no-gateway`, `turno <p> --no-gateway`, `turno auto --no-gateway`, or any of them
with `TURNO_SAFE=1`, opens the agent with the profile's account but without the gateway. turno
does not run the launcher (it would export the token); it runs the agent's own command with the
environment the launcher gives the profile (ADR 0032), minus `TURNO_MCPD_TOKEN`,
`TURNO_SESSION_PID` and `TURNO_SESSION_CWD_B64`, plus `TURNO_SAFE=1` so a turno started inside
stays safe. The run record is written as the launcher writes it.

How the gateway entries are left out is per agent, so it is an adapter hook, `safeMode`:

| Agent | Arguments | Why this one |
|---|---|---|
| Claude Code | `--strict-mcp-config --mcp-config <file>` with the profile's user and project servers and this folder's `.mcp.json`, minus gateway entries; `--settings {"disableAllHooks":true}` | the only documented way to skip configured servers for one run; `disableAllHooks` is the documented switch for a custom status line |
| Codex CLI | `-c mcp_servers.<name>.enabled=false` per gateway entry | `-c mcp_servers={}` deep-merges and removes nothing |
| Copilot CLI | `--disable-mcp-server=<name>` per gateway entry | documented, repeatable |
| Cursor CLI | none | no per-run switch (`agent mcp disable` persists); the entries start without the token, so mcpd refuses them |

A gateway entry is recognized by its shape (`X-Turno-Profile` or `X-Turno-Pid` header, the
`TURNO_MCPD_TOKEN` bearer variable, or a `127.0.0.1:<port>/mcp/<name>` URL), so entries written
by hand from `turno mcp config` count too. The Claude Code file is private (mode 600) under
`~/.local/state/turno/safe/`, since a server's env may hold a literal secret.

### `X-Turno-Cwd-B64` for Copilot CLI and Cursor CLI

Both document variable expansion in remote server headers: Copilot `${VAR}` ("Supports variable
expansion", CLI command reference) and Cursor `${env:VAR}` ("resolves variables in ... url, and
headers", and the CLI changelog: placeholders "expand in MCP configs everywhere"). Their gateway
entries now send `X-Turno-Cwd-B64` from `TURNO_SESSION_CWD_B64`, which every launcher already
exports. Outside a launcher the variable is unset; what each client then sends is undocumented
(empty, or the text left as written), and neither decodes as base64url, so mcpd keeps its
process-folder fallback. `turno mcp sync` rewrites existing entries.

### `system = ""` everywhere

`""` means "the hub has no account of mine". Every place that read `system ?? "default"` now
reads `system || "default"` (the hub's gateway token, `mcp call`, doctor), so `""` never becomes
an empty profile name, and `status` and `profile which` say "no profile" instead of "plain
claude" for folders without a rule.

## Consequences

- A reported problem can be split in two with one flag, and the report block replaces five
  commands. The doctor checks stay the only source of findings; the report only formats them.
- `safeMode` is one more required adapter member; a new agent must say how it leaves the gateway
  out, or return no arguments with a note, as Cursor does.
- Safe Claude Code sessions run without hooks (turno's rate-limit hook and the user's own) and
  without plugin MCP servers, because `--strict-mcp-config` skips them. This is stated when the
  session starts.
- Copilot's header expansion is from its documentation and has not been checked against the real
  CLI. If it does not expand, mcpd gets a value that is not base64url, ignores it and uses the
  process folder, as before.
- Codex server names with a dot cannot be turned off with `-c` (the key splits at dots); safe mode
  says so, and mcpd refuses them anyway because the token is gone.

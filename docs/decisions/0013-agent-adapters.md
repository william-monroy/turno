# 0013. Agent adapters: Claude Code, Codex, Copilot and Cursor profiles, and gateway snippets for the rest

Date: 2026-11-13. Status: accepted, refined by ADR 0032 (Codex and Cursor details verified locally; Copilot from
its documentation only).

## Context

turno grew around one trick: Claude Code keeps everything under `CLAUDE_CONFIG_DIR`, so one
directory per account gives one login per account, and symlinks to a hub share the rest. Other
coding agents have the same switch: Codex `CODEX_HOME`, Copilot CLI `COPILOT_HOME`, Cursor CLI
`CURSOR_CONFIG_DIR`. The MCP gateway is agent-neutral already: any client that speaks
streamable HTTP with headers can use it.

Verified on 2026-11-13 against Codex CLI 0.153.2 and Cursor CLI 2026.10.01, in temporary
directories:

- Codex reads `[mcp_servers.<name>]` with `url`, `bearer_token_env_var`, `http_headers` and
  `env_http_headers` (`codex mcp get --json` shows them), and with
  `cli_auth_credentials_store = "file"` a fresh `CODEX_HOME` is logged out: logins are per
  directory.
- `CURSOR_CONFIG_DIR` moves `cli-config.json` only. MCP servers still come from
  `~/.cursor/mcp.json` (shared with the Cursor editor). Cursor expands `${env:VAR}` in MCP
  headers (a local server saw the token, profile and PID sent from the environment). The login
  lives in the macOS Keychain and is shared by every config dir unless
  `AGENT_CLI_CREDENTIAL_STORE=file` is set; with it, a fresh config dir is logged out. That
  variable is not documented by Cursor.
- Not verified: whether a Codex session started by one ChatGPT account can be resumed by
  another; Copilot's `mcp-config.json` variable expansion.

## Decision

- A profile has an agent: `[profiles.<name>] agent = "claude" | "codex" | "copilot" |
  "cursor"`, default `claude`. Profile names stay unique across agents. `turno profile add
  <name> --agent codex` writes it. Profiles of agents other than Claude Code are found through
  config.toml only.
- Each agent is an adapter (`src/agents/`): its command, the variable that moves its home, the
  profile directory (`~/.claude-<n>`, `~/.codex-<n>`, `~/.copilot-<n>`, `~/.cursor-<n>`), the
  launcher name (`claude-<n>`, `codex-<n>`, `copilot-<n>`, `cursor-agent-<n>`), the hub items
  shared through symlinks, extra environment, where gateway entries go and in which format.
- Codex profiles: `config.toml` is seeded from `~/.codex/config.toml` once and always has
  `cli_auth_credentials_store = "file"`; `sessions`, `prompts`, `skills` and `AGENTS.md` link to
  `~/.codex`. Gateway entries use `bearer_token_env_var` and `env_http_headers`, so the token is
  never written to the file; the launcher exports it from the mcpd token file.
- Copilot profiles: `session-state` links to `~/.copilot`; gateway entries go to the profile's
  `mcp-config.json` as `type: "http"` with `${VAR}` headers (unverified).
- Cursor profiles: the launcher sets `CURSOR_CONFIG_DIR` and `AGENT_CLI_CREDENTIAL_STORE=file`.
  Since `mcp.json` cannot move, gateway entries go once into `~/.cursor/mcp.json` with
  `${env:TURNO_PROFILE}`-style headers; each launcher's environment routes them. Outside a turno
  launcher (the Cursor editor) those entries have no token and fail closed with 401.
- Folder rules apply per agent: `turno auto` resolves among Claude Code profiles as before, and
  `turno auto --agent codex` among Codex ones. `[agents.<id>] default` and `fallback` give the
  other agents the same optional keys. Exhausted marks are per profile, so `turno limit set`
  works for any agent; automatic detection stays Claude Code only (its hook).
- Claude-only features stay Claude-only: the status line, usage windows, the accounts bridge,
  session handoff. Commands that list profiles for them skip other agents.
- Every other agent with remote MCP gets a print-only snippet: `turno mcp config --agent
  <opencode|gemini|goose|crush|droid|kiro> [--profile <p>]`, with the token read from
  `TURNO_MCPD_TOKEN` where the agent expands variables. turno does not edit those files.
- Out: Amp (threads and MCP definitions live server-side), Aider (no MCP).

## Consequences

- New agents are a new adapter file plus tests; the CLI commands do not change.
- Cross-account resume for Codex is offered by the shared `sessions` folder but documented as
  unverified until someone tries it with two ChatGPT accounts.
- `AGENT_CLI_CREDENTIAL_STORE` may change without notice; `turno doctor` reports a Cursor
  profile whose login is not isolated.

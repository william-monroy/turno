# Default accounts, subprocesses and subagents

A turno profile is a folder (`~/.claude-work`) plus an environment variable that points the
agent at it (`CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME`, `COPILOT_HOME`,
`CURSOR_CONFIG_DIR` for the others). The launcher (`claude-work`, `turno work`, `turno auto`)
exports that variable and then replaces itself with the agent. So the account follows the
environment, and it is worth knowing where the environment goes and where it does not.

## Inside a session: the same account

Everything the agent starts inherits its environment, so it runs with the same account:

- Claude Code subagents (the Task tool) run inside the same Claude Code process.
- Commands of the Bash tool, hooks and stdio MCP servers that Claude Code starts itself.
- A `claude -p ...` or `codex exec ...` that the session runs: it sees the same
  `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, so it uses the same login.
- `turno open` and the `BROWSER` the launcher sets, so claude.ai links open with that account.

MCP servers behind the gateway are the exception: mcpd starts them, not the session, so they
see mcpd's environment. turno tells mcpd which profile and session a request comes from; see
[mcp.md](mcp.md) for servers that need one process per profile.

## Outside a session: the default account

Anything started without the variable uses the agent's own folder (`~/.claude`, `~/.codex`,
...), which turno calls the hub. For Claude Code, the account signed in there is the one
`system` names in `config.toml`. That happens with:

- a plain `claude` in a new terminal (not `turno auto` or a launcher);
- scripts that clear the environment (`env -i`, `sudo`, some task runners);
- cron jobs, LaunchAgents and other background jobs;
- apps and editor extensions opened from the Dock or a menu instead of a terminal.

If the account in `~/.claude` is a personal one, any of these can spend it or act with it in a
work repository. Three ways to avoid that:

1. Start agents through turno: `turno auto` (or the `turno-auto` launcher, for editors that let
   you pick the command) resolves the folder's account every time.
2. Sign the hub out, so a stray process fails to authenticate instead of using an account: run
   plain `claude`, then `/logout`. Profiles keep their own logins.
3. Tell turno there is no default account: `turno config set system ""`. Then `turno auto` in a
   folder without a rule (and without a `default`) exits with an error instead of running the
   plain agent. turno does not wrap the plain `claude` command, so this does not change what
   item 2 covers.

## What turno auto never does

`turno auto` does not switch accounts in silence. When the folder's profile has no launcher,
when a rule names a profile that does not exist, or when `config.toml` does not parse, it
exits 1 with the reason and the command that fixes it. `TURNO_ALLOW_PLAIN=1` runs the plain
agent despite a broken `config.toml`, for the rare moment you need it.
[ADR 0021](decisions/0021-no-silent-account-fallback.md) records why.

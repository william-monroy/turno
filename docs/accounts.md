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

## Service accounts and the accounts bridge

A service account is a Linear workspace, a Gmail connector or any other MCP server that one
profile reaches. `turno identity add` records which profile owns it, in
`~/.config/turno/accounts.toml`:

```toml
[account."linear:work"]
profile = "work"
tools = ["mcp__linear__*"]
read_tools = ["mcp__linear__get_*", "mcp__linear__list_*"]

[account."gmail:work"]
profile = "work"
tools = ["mcp__claude_ai_Gmail__*"]
read_tools = ["mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__get_thread"]
# confirm = "always" is the default for mail and messaging services
```

```sh
turno identity add linear:work --profile work --tools 'mcp__linear__*' \
  --read-tools 'mcp__linear__get_*,mcp__linear__list_*' --confirm writes
```

A session of another profile (say `personal`) sees these accounts through the `accounts` MCP
server: `accounts_list`, and `accounts_delegate`, which runs a task headless in the owning
profile and returns the outcome. What a delegated run may do does not depend on what the
calling model claims:

- **Reads** (`write = false`) get only `read_tools`. Every other tool of the account is refused
  by Claude Code, so a read cannot send, post or delete, even if a page or an email the session
  read tells it to. Each read tool must be covered by `tools`. turno cannot know whether a tool
  only reads: list only tools that do.
- **An account without `read_tools`** has no safe read, so every call to it is confirmed like a
  write, and the run gets every tool of the account.
- **Writes** (`write = true`) get every tool of the account.
- **`confirm`** says when the user is asked, through an MCP elicitation form in the calling
  session:

  | `confirm` | Reads with `read_tools` | Reads without `read_tools` | Writes |
  |---|---|---|---|
  | `always` (default for mail and messaging) | ask | ask | ask |
  | `writes` (default elsewhere) | run | ask | ask |
  | `never` | run | run, every tool | run |

  Mail and messaging means `gmail`, `outlook`, `slack`, `teams`, `discord`, `telegram`,
  `whatsapp`, `signal`, any service whose name contains `mail`, and a few more
  (`src/accounts/policy.ts`). A client that does not support elicitation cannot confirm, so
  calls that need it are refused there.

`turno identity list` shows each account's policy and read tools.

### How the run is isolated

The delegated run is `claude-<profile> -p ...` with:

- `--permission-mode dontAsk`, `--tools ""` (no built-in tools: no shell, no files, no web),
  `--allowedTools` with the decided tools, and the bridge itself disallowed;
- `--setting-sources ""`: no user, project or local settings, so allow rules, hooks and plugins
  from settings files cannot widen it;
- its own empty folder, `~/.local/state/turno/delegate/<profile>`, never the caller's folder,
  so the caller's `CLAUDE.md` and `.claude/` do not apply;
- a minimal environment: `HOME`, `PATH`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TZ`,
  `TMPDIR`, `TERM`, and the proxy and CA variables. The launcher adds the profile's own;
- `--mcp-config` with only the account's servers and `--strict-mcp-config`, when each of those
  servers is a turno gateway entry in the profile. claude.ai connectors (`mcp__claude_ai_*`) do
  not load under `--strict-mcp-config`, so for them the profile's MCP config stays, and the
  allowed tools are the limit.

The result comes back marked as data from another account, capped at 20,000 characters, with
any tool the run tried and was refused listed after it.

### Audit log

Every call to `accounts_delegate` adds a line to `~/.local/state/turno/audit.jsonl` (mode 600,
hash-chained): caller, account, task, outcome, cost, and the decision (policy, whether the user
was asked and what they answered, read or all tools, the allowed patterns, whether the MCP
config was strict, refused tools). `turno identity log` prints the recent ones.
[ADR 0024](decisions/0024-accounts-bridge-policy-and-isolated-runs.md) records the design.

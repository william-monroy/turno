# Other agents

turno started with Claude Code, and its profiles, folder rules and MCP gateway work with other
coding agents too. Why and how: [ADR 0013](decisions/0013-agent-adapters.md); where the code for
each agent lives: [ADR 0032](decisions/0032-agent-adapter-boundary.md).

| Agent | Profiles and launcher | Gateway entries | Shared from the hub | Notes |
|---|---|---|---|---|
| Claude Code | `~/.claude-<p>`, `claude-<p>` | `.claude.json` (`turno mcp sync`) | projects, sessions, skills, plugins, settings, ... | status line, usage, accounts bridge, handoff |
| Codex CLI | `~/.codex-<p>`, `codex-<p>` | `config.toml` (`turno mcp sync`) | `sessions`, `prompts`, `skills`, `AGENTS.md` | login per profile (`cli_auth_credentials_store = "file"`) |
| GitHub Copilot CLI | `~/.copilot-<p>`, `copilot-<p>` | `mcp-config.json` (`turno mcp sync`) | `session-state` | not tested against the real CLI yet |
| Cursor CLI | `~/.cursor-<p>`, `cursor-agent-<p>` | `~/.cursor/mcp.json`, shared (`turno mcp sync`) | none | login per profile via `AGENT_CLI_CREDENTIAL_STORE=file` |
| opencode, Gemini CLI, Goose, Crush, Droid, Kiro | not managed | `turno mcp config --agent <name>` prints them | none | paste the snippet yourself |

Amp keeps threads and MCP definitions on its servers, and Aider has no MCP support, so turno
does not cover them.

## A Codex profile

```sh
turno profile add cx --agent codex   # ~/.codex-cx, codex-cx, config.toml with file credentials
codex-cx login                       # sign in once, with the ChatGPT account of this profile
turno mcp sync cx                    # point it at the gateway (the token stays in the environment)
turno profile assign ~/code/acme cx  # this folder uses cx for Codex
turno auto --agent codex             # the Codex profile of this folder
```

`config.toml` is copied from `~/.codex/config.toml` the first time, and turno always keeps
`cli_auth_credentials_store = "file"` in it, so the login stays inside the profile instead of
the shared Keychain. The `sessions` folder is shared, so `codex-other resume <id>` can continue
a session started by another profile; that has not been verified across two ChatGPT accounts,
so treat it as experimental.

## Folder rules per agent

A folder can have one rule per agent: `turno profile assign <dir> <profile>` adds a rule for the
profile's agent. `turno auto` resolves among Claude Code profiles, `turno auto --agent codex`
among Codex profiles. `turno profile unassign <dir>` removes the folder's rules of every agent. Defaults and fallbacks of the other agents live in their own table:

```toml
[profiles.cx]
agent = "codex"

[agents.codex]
default = "cx"
# fallback = "cx2"   # optional, off unless set; see the vendor terms notice in the README
```

`turno auto --agent codex` in a folder without a Codex rule or default runs plain `codex` and says
so; before any Codex profile exists it says that too. What happens to processes started outside a
launcher, and how to have no default account at all: [accounts.md](accounts.md).

Exhausted marks are per profile (`turno limit set cx --for 3h`). Only Claude Code marks them by
itself, through the plugin's hook.

## Cursor

Cursor CLI moves only `cli-config.json` with `CURSOR_CONFIG_DIR`; its MCP servers always come
from `~/.cursor/mcp.json`, which the Cursor editor reads too. turno writes the gateway entries
there once, with `${env:...}` headers: inside a `cursor-agent-<p>` launcher they carry the token
and the profile, and anywhere else (the editor) they have no token and the gateway refuses them.
Cursor asks to approve each new server once: `cursor-agent-<p> mcp enable <name>`.

The login is per profile only with `AGENT_CLI_CREDENTIAL_STORE=file`, which the launcher sets.
Cursor does not document that variable; if a future version drops it, every profile would share
the Keychain login again.

## Agents turno does not manage

```sh
turno mcp config --agent opencode --profile work
```

prints the entries of every gateway server for that agent, with the file they go in. Where the
agent expands variables the token is read from `TURNO_MCPD_TOKEN`, set to the profile's own token
(`export TURNO_MCPD_TOKEN="$(cat ~/.local/state/turno/mcpd-tokens/work.token)"` in your shell
profile; the command writes that file); Goose gets a placeholder you replace by hand.

## Not covered (yet)

- Status line, usage windows, the accounts bridge and session handoff are Claude Code only.
- Automatic exhausted marks for Codex: its rollouts carry rate-limit data, but there is no
  documented signal yet.

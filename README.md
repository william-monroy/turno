# turno

Run several Claude Code accounts on one Mac as if they were one: shared conversations, memory,
skills and plugins, a rule for which of your accounts each folder uses, and one local gateway
that starts each MCP server once instead of once per session.

```
turno work                  # Claude Code logged into the "work" account
turno auto                  # the account assigned to this folder
turno status                # this folder, every account and its usage, sessions, mcpd
turno limit show --watch    # 5 h and weekly usage of every account, live
```

## Why

Claude Code keeps one login per config directory. Running two accounts means two
`CLAUDE_CONFIG_DIR`s, and by default they share nothing: a conversation started with one account
cannot be resumed with the other, and every session starts its own copy of every MCP server.
With a dozen sessions open, the same browser and API servers run a dozen times over.

turno fixes both:

- **Profiles.** Each account gets `~/.claude-<name>` with its own credentials and history, and
  symlinks to the shared hub (`~/.claude`) for projects, plans, skills, plugins, agents and
  settings. `turno <name> --resume <id>` continues any session with any account.
- **Rules.** `config.toml` maps folders to profiles, and `turno auto` picks the right one. An
  optional `fallback` (off unless you set it) names the profile to open while the assigned one
  is marked exhausted; see [Vendor terms](#vendor-terms) before you turn it on.
- **mcpd.** A small HTTP gateway on `127.0.0.1` that every profile's MCP entries point to. It
  answers `initialize` and the tool lists from a cache, starts a server only when a tool is called,
  shares one process between sessions where that is safe, and stops it when idle.
- **Browser with real profiles** (optional package). `turno-browser-mcp` is the Playwright MCP
  server built on Patchright, driving your installed Chrome with a persistent profile per
  identity, so the sites you sign into once stay signed in.
- **Accounts bridge.** A builtin MCP server that lets a session in one profile delegate a task to
  a service account (a Linear workspace, a mail connector) that only another profile is logged
  into, with confirmation for anything that writes.

## Install

Requirements: macOS (Linux works for everything but the Keychain and the LaunchAgent), Node 22.11
or newer, Claude Code (`claude` on PATH).

From the source (pnpm needed):

```sh
git clone <this repository> turno && cd turno
pnpm install && pnpm build
ln -s "$PWD/packages/turno/dist/cli/main.js" ~/.local/bin/turno
turno ui install                   # status line font (MesloLGS Nerd Font) and the turno status line
echo 'source <(turno completion zsh)' >> ~/.zshrc
turno doctor
```

Once it is published to npm it installs with `npm install --global <package>` (or pnpm, yarn,
bun, volta), and `turno upgrade` keeps any of those installs, or a git checkout, up to date.
See [docs/RELEASING.md](docs/RELEASING.md) for versions and releases.

## Quick start

```sh
turno profile add work --color violet       # declare the profile, create ~/.claude-work and claude-work
turno profile add personal --browser default
claude-work                                   # log in once per profile (/login)
turno profile assign ~/code/acme work       # this folder and everything under it uses work
turno config set default personal           # profile for folders without a rule
turno status                                # who is logged in where, and their usage
```

`~/.config/turno/config.toml`:

```toml
system = "personal"     # account the plain `claude` command uses
default = "personal"    # profile for folders without a rule
# fallback = "work"     # optional, off unless set: opened while the assigned profile is exhausted

[profiles.work]
color = "violet"        # status line pill
[profiles.personal]
browser = "default"     # claude.ai links open in the default browser instead of a Chrome profile

[[projects]]
path = "~/code/acme"
profile = "work"
```

Point terminals and editors at `turno auto` (or the `turno-auto` launcher) and every folder
opens with its account.

## Commands

`turno --help` groups them; `turno <command> --help` explains each. Every command that only
reads takes `--json`; every command that writes takes `--dry-run`, keeps a copy of each file it
changes, and prints the `turno undo <stamp>` that puts them back.

| Command | What it does |
|---|---|
| `turno <profile> [args]`, `turno run <profile\|auto> [args]` | Claude Code with that account (replaces the process, args pass through) |
| `turno auto [--agent codex]` | the profile assigned to the current folder (and the fallback, if you set one) |
| `turno profile list\|add\|repair\|remove\|which\|assign\|unassign` | the accounts, and which folders use each |
| `turno limit show [--watch]\|set <p> [--until \| --for]\|clear <p>` | usage windows, and exhausted marks (used by the optional fallback) |
| `turno session list\|handoff <p> [--fork]` | open sessions, and the command to continue or fork this one under another profile |
| `turno open [profile] <url>` | open a link; claude.ai links use that profile's Chrome profile |
| `turno mcp list\|sync\|config\|import\|install\|refresh\|doctor\|daemon ...` | the MCP gateway (below), and entries for other agents |
| `turno identity list\|add\|remove\|login\|prefer\|log` | service accounts for the bridge and browser identities |
| `turno secret set\|has\|rm\|list` | MCP secrets in the macOS Keychain |
| `turno browser bench` | how automation-fingerprint test pages see each browser engine |
| `turno ui status\|install` | the status line, its font and icons in every terminal |
| `turno status` | one screen: this folder, profiles and usage, sessions, mcpd, the look |
| `turno doctor [--fix]` | check everything and repair what is safe to repair |
| `turno config path\|get\|set\|unset\|edit\|check` | config.toml without losing its comments |
| `turno undo [--list] [<stamp>\|last]` | put back the files a command changed |
| `turno upgrade [--check]`, `turno version` | update turno the way it was installed |
| `turno completion zsh\|bash\|fish` | shell completion, including profiles and config keys |
| `turno migrate` | import the config of the original bash version (`turno undo` rolls it back) |

The names of 0.1 (`setup`, `which`, `sessions`, `usage`, `exhausted`, `available`, `handoff`,
`accounts`, `mcpd`) and the Spanish ones of the bash version still work.

## MCP gateway

```sh
turno mcp import --move-secrets            # draft mcp.toml from your current servers
turno mcp import --move-secrets --write    # write it (secrets go to the Keychain)
turno mcp install                          # pin npm packages once instead of npx per start
turno mcp daemon start                     # LaunchAgent that keeps the gateway alive
turno mcp sync                             # point every profile at the gateway
```

`~/.config/turno/mcp.toml`:

```toml
[server.calendar]
command = "cal-mcp"
package = "@calcom/cal-mcp@1.4.0"
env = { CAL_API_KEY = "keychain:turno/calendar/api-key" }
scope = "shared"                 # one process for every session

[server.devtools]
command = "chrome-devtools-mcp"
package = "chrome-devtools-mcp@0.9.0"
scope = "session"                # one per Claude session, stopped when the session ends
idle = "15m"

[server.issues]
command = "issues-mcp"
[server.issues.variant.work]     # the work profile reaches a different account
env = { ISSUES_TOKEN = "keychain:turno/issues/work" }

[server.browser-school]
command = "turno-browser-mcp"
args = ["--identity", "school"]
exclusive = true                 # one session at a time drives this browser
lease = "10m"

[server.docs]
url = "https://docs.example.com/mcp"   # remote, written straight into each profile
```

Scopes: `shared` (one process), `project` (one per git repository), `session` (one per Claude
session). Each server variant per profile runs separately, so two profiles can reach two
different accounts of the same service. Details in [docs/mcp.md](docs/mcp.md).

The gateway listens on `127.0.0.1` only, requires a bearer token (mode 600 file), and rejects any
request with an `Origin` header, so a web page cannot reach it.

## Browser with real profiles

```sh
npm install --global turno-browser   # optional: only if you want it
turno identity add browser:school    # create an identity and print its mcp.toml entry
turno identity login browser:school  # sign in by hand once; cookies persist
turno browser bench --url https://portal.example.edu
```

It drives the installed Google Chrome, headed, with a persistent profile per identity and no
injected scripts, so an agent works in the same browser and session you would use yourself.
Read [ADR 0005](docs/decisions/0005-stealth-browser-defaults.md) for the settings and what they
do and do not change.

**Acceptable use.** Use it with your own accounts, on sites whose terms allow automated access
by you, and at a human pace. Do not use it to get around access controls, paywalls, CAPTCHAs or
rate limits, to scrape at scale, or to access accounts that are not yours. You are responsible
for how you use it; see [Disclaimers](#disclaimers).

## Accounts bridge

```sh
turno identity add linear:work --profile work --tools 'mcp__linear__*'
turno identity prefer ~/code/acme linear=linear:work
```

Add `[server.accounts]` with `builtin = "accounts"` to `mcp.toml`. Sessions then get
`accounts_list` and `accounts_delegate`. A delegated task runs headless in the owning profile
with only that account's tools allowed; write tasks need your confirmation in the client, and
every call goes to an audit log (`turno identity log`).

## Other agents

Codex CLI, GitHub Copilot CLI and Cursor CLI profiles work the same way: one folder and one
login per account, a launcher, folder rules and the MCP gateway.

```sh
turno profile add cx --agent codex   # ~/.codex-cx and the codex-cx command
codex-cx login
turno mcp sync cx
turno auto --agent codex
```

opencode, Gemini CLI, Goose, Crush, Droid and Kiro can use the gateway too: `turno mcp config
--agent <name>` prints their entries. Details and caveats: [docs/agents.md](docs/agents.md).

## Companion plugin

`plugins/turno` adds the hook that marks a profile exhausted when it hits its limit (it only
changes which profile opens next if you set a `fallback`), plus the
`switch-account` and `fork-session` skills. Install it from this repository:

```
/plugin marketplace add /path/to/turno
/plugin install turno@turno
```

## Status line

![The turno status line with Nerd Font icons, after a fallback switch, and with Unicode icons](docs/assets/statusline.png)

```sh
turno ui install                     # font + statusLine in the shared settings.json
turno ui install --terminal current  # also set the font in this terminal (Warp, VS Code, Cursor, Alacritty)
turno ui status                      # what each installed terminal will draw
```

Row 1: profile and plan, 5 h and weekly usage of that account (the freshest any session has
seen) with time to reset, context, estimated turns left, and a warning when a fallback is active
or the folder belongs to another profile. Row 2: project and worktree, branch, lines changed,
model and effort, and the real API-equivalent cost of the conversation including subagents.

The icons come from a Nerd Font. turno ships MesloLGS Nerd Font 3.4.0 (`packages/fonts`), the
same Nerd Fonts release and icon size as Orca's terminal, and `turno ui install` copies it into
your user font folder; terminals that ship the symbols
(Ghostty, WezTerm, kitty) need nothing. Where no Nerd Font is set the line falls back to Unicode
icons by itself. Details: [docs/ui.md](docs/ui.md).

## Disclaimers

### Not affiliated

turno is an independent open-source project. It is not affiliated with, endorsed by or
sponsored by Anthropic, OpenAI, GitHub, Google, Anysphere or any other vendor. Claude, Claude
Code, Codex, Copilot, Cursor and Gemini are trademarks of their owners; turno uses the names
only to say which tools it works with. turno runs the vendors' own, unmodified command-line
tools.

### Vendor terms

Each account you add is yours and stays bound by its vendor's terms; turno does not change
them. turno never reads, stores or forwards your login tokens, and it does not proxy model
traffic: every agent logs in by itself, in its own directory. Before you use several accounts:

- Check that your plan allows it, and use each account for what its terms allow (for example,
  a work account for work).
- The `fallback` setting is off by default. It chooses which of your own accounts opens a
  folder while another is marked exhausted. Vendors' usage policies forbid creating or using
  accounts to get around usage limits or safeguards, so read your plan's terms before you set
  it, and do not use it for that.

### No warranty

turno is provided "as is", without warranty of any kind (Apache License 2.0, sections 7 and 8).
It edits agent config files and launches programs as your user; every write keeps a backup
that `turno undo` restores.

### Update check

Interactive commands ask the npm registry for a newer version at most once a day, sending only
the package name. Turn it off with `update_check = false` in config.toml, `DO_NOT_TRACK=1`,
`NO_UPDATE_NOTIFIER=1` or `TURNO_NO_UPDATE_CHECK=1`; it is also off in CI and outside a
terminal. turno sends no other data anywhere.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md) and the
[AI policy](AI_POLICY.md). Security issues: [SECURITY.md](SECURITY.md). Governance:
[GOVERNANCE.md](GOVERNANCE.md).

## Files

| Path | What |
|---|---|
| `~/.config/turno/config.toml` | profiles and folder rules |
| `~/.config/turno/mcp.toml` | MCP servers behind the gateway |
| `~/.config/turno/accounts.toml` | service accounts for the bridge |
| `~/.local/state/turno/` | usage, exhausted marks, run records, logs, backups, mcpd token |
| `~/.local/share/turno/` | installed servers, description cache, browser identities |

All three honor `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_DATA_HOME`.

## Development

```sh
pnpm install
pnpm build
pnpm test        # unit and integration tests, sandboxed HOME
pnpm check       # typecheck, tests, and the repository text rules
```

Design: [docs/design](docs/design/2026-11-12-turno-ecosystem-design.md). Decisions:
[docs/decisions](docs/decisions/). Progress: [docs/STATUS.md](docs/STATUS.md).

## License

Apache License 2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)). The bundled fonts keep their own
licenses ([packages/fonts/LICENSE.txt](packages/fonts/LICENSE.txt)); dependencies are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

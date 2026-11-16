<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo-light.svg" alt="turno" width="168" height="56">
  </picture>
</p>

<p align="center">
  <b>One MCP gateway and per-folder accounts for Claude Code, Codex, Copilot CLI and Cursor CLI.</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/turno"><img alt="npm" src="https://img.shields.io/npm/v/turno?color=2457F5"></a>
  <a href="https://github.com/william-monroy/turno/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/william-monroy/turno/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/william-monroy/turno"><img alt="OpenSSF Scorecard" src="https://api.scorecard.dev/projects/github.com/william-monroy/turno/badge"></a>
</p>

<p align="center">
  English · <a href="README.es.md">Español</a>
</p>

Every coding-agent session starts its own copy of every MCP server. Eight sessions with six
common servers is **3,163 MiB in 56 processes**. turno starts each server once,
only when a tool is called, behind one local gateway that every session of every agent shares:
**847 MiB while all six run, 103 MiB while they sit idle**
([benchmark](BENCHMARKS.md)). It also gives each folder its own account, so work repositories
open with your work login and everything else with your personal one.

![turno: profiles for two agents, one gateway, the status line](docs/assets/demo.gif)

## Install

```sh
npx turno@latest doctor     # try it without installing: checks your agents and config
npm install --global turno  # macOS or Linux, Node 22.11+
```

Then move your MCP servers behind the gateway:

```sh
turno mcp import --move-secrets --write   # mcp.toml from the servers you already have
turno mcp daemon start                    # the gateway, kept alive by launchd
turno mcp sync                            # point every agent profile at it
```

Nothing leaves your machine: no account, no telemetry, no proxy for model traffic.

## What it does

- **One MCP gateway for every session.** `mcpd` listens on `127.0.0.1`, answers `initialize` and
  the tool lists from a cache, starts a server the first time one of its tools is called, shares
  that process between sessions where it is safe (`shared`, `project` or `session` scope) and
  stops it when idle. Secrets live in the macOS Keychain, not in agent configs.
- **An account per folder.** `turno profile assign ~/code/acme work` and every agent you open in
  that repository uses your work login; `turno auto` picks it, and `turno status` shows who is
  logged in where. Conversations, skills and settings stay shared between your Claude Code
  profiles, so `turno work --resume <id>` continues a session started with another account.
- **Four agents, one setup.** The same profiles, folder rules and gateway for:

  | Agent | Profile | Gateway entries | Example |
  |---|---|---|---|
  | Claude Code | `~/.claude-<p>`, `claude-<p>` | `.claude.json` | `turno work` |
  | Codex CLI | `~/.codex-<p>`, `codex-<p>` | `config.toml`, token from the environment | `turno auto --agent codex` |
  | GitHub Copilot CLI | `~/.copilot-<p>`, `copilot-<p>` | `mcp-config.json` | `copilot-work` |
  | Cursor CLI | `~/.cursor-<p>`, `cursor-agent-<p>` | `~/.cursor/mcp.json`, routed by environment | `cursor-agent-work` |

  opencode, Gemini CLI, Goose, Crush, Droid and Kiro can use the gateway too:
  `turno mcp config --agent <name>` prints their entries. See [docs/agents.md](docs/agents.md).
- **A status line** for Claude Code with the account, its 5 h and weekly usage, context, branch
  and cost, with Nerd Font icons it installs for you (or Unicode where there is none).
- **A browser with real profiles** (optional `turno-browser`): an MCP server that drives your
  installed Chrome with one persistent profile per identity, so an agent works in the sessions
  you signed into by hand.

## Quick start

```sh
turno profile add work --color violet     # ~/.claude-work and the claude-work command
turno profile add personal
claude-work                               # sign in once per profile (/login)
turno profile assign ~/code/acme work     # this folder and everything under it
turno config set default personal         # folders without a rule
cd ~/code/acme && turno auto              # Claude Code, signed in as work
```

Codex, Copilot and Cursor profiles are the same with `--agent codex|copilot|cursor`. Point your
terminal or editor at `turno auto` (or the `turno-auto` launcher) and every folder opens with
its account.

## Benchmark

Six popular local MCP servers (Playwright, Chrome DevTools, filesystem, memory, sequential
thinking, Context7), each session running `initialize` and `tools/list` on all of them. Resident
memory of every process involved, Apple M3 with 16 GB, Node 26, 2026-11-16:

| Sessions | Each session starts its own servers | turno, all six servers running | turno, idle (tool lists cached) |
|---|---|---|---|
| 4 | 1,410 MiB, 28 processes | 692 MiB, 8 processes | 101 MiB, 1 process |
| 8 | 3,163 MiB, 56 processes | 847 MiB, 8 processes | 103 MiB, 1 process |

Started the way most server READMEs suggest (`npx -y <package>`), 4 sessions take
3,123 MiB in 52 processes. Reproduce it with `node bench/mcp-ram.mjs --sessions 8`;
method and caveats in [BENCHMARKS.md](BENCHMARKS.md).

## How it compares

| | Accounts per folder | Several agents | Shared MCP processes | Status line | Notes |
|---|---|---|---|---|---|
| **turno** | yes | Claude Code, Codex, Copilot CLI, Cursor CLI | yes, lazy | yes | CLI, local only |
| [claude-swap](https://github.com/realiti4/claude-swap) | switch, not per folder | Claude Code | no | no | usage dashboard, parallel sessions |
| [clauth](https://github.com/uwuclxdy/clauth) | switch | Claude Code | no | no | TUI, cross-account delegation |
| [cc-switch](https://github.com/farion1231/cc-switch) | no | many | no (manages MCP config) | no | desktop app, provider switching |
| [ccstatusline](https://github.com/sirmalloc/ccstatusline) | no | Claude Code | no | yes | the most customizable status line |
| [MetaMCP](https://github.com/metatool-ai/metamcp), [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) | no | any MCP client | aggregates or bridges | no | Docker / transport bridge |
| Plain `CLAUDE_CONFIG_DIR` | by hand | one | no | no | what turno automates |

If you only need one of these pieces, those tools are good at it. turno is for the case where
you run many sessions of several agents with more than one account.

## FAQ

**Is using several accounts allowed?** That depends on your plan, not on turno. turno runs each
vendor's own, unmodified CLI, and each account signs in with the vendor's own login in its own
folder. The intended use is separate work and personal accounts. Do not use it to get around
usage limits or safeguards; see [Vendor terms](#vendor-terms).

**Where are my credentials?** Where each agent keeps them, inside that profile's folder (or the
Keychain where the agent uses it). turno never reads, copies or forwards login tokens. MCP
secrets you move with `--move-secrets` go to the macOS Keychain.

**Does turno see my prompts or model traffic?** No. It launches the agent and gets out of the
way. Only MCP tool calls go through `mcpd`, on `127.0.0.1`, with a bearer token, and requests
with an `Origin` header are rejected so web pages cannot reach it.

**Linux? Windows?** Linux works for everything except the Keychain and the LaunchAgent (both
have open issues). Windows is not supported.

**How do I undo it?** Every command that writes keeps a copy of each file it changes:
`turno undo --list` shows them and `turno undo <stamp>` puts them back. To remove turno,
`turno mcp daemon stop`, undo the `mcp sync`, delete the `claude-<p>`-style launchers in
`~/.local/bin` and `npm uninstall --global turno`. Profile folders stay until you delete them.

## Reference

`turno --help` groups the commands and `turno <command> --help` explains each. Commands that
only read take `--json`; commands that write take `--dry-run`, keep a copy of each file they
change, and print the `turno undo <stamp>` that puts them back.

| Command | What it does |
|---|---|
| `turno <profile> [args]`, `turno run <profile\|auto> [args]` | the profile's agent with that account (args pass through) |
| `turno auto [--agent codex\|copilot\|cursor]` | the profile assigned to the current folder |
| `turno profile list\|add\|repair\|remove\|which\|assign\|unassign` | the profiles, and which folders use each |
| `turno mcp list\|sync\|config\|import\|install\|refresh\|doctor\|daemon ...` | the MCP gateway, and entries for other agents |
| `turno status` | one screen: this folder, profiles and usage, sessions, mcpd |
| `turno limit show [--watch]\|set\|clear` | usage windows per account, and exhausted marks |
| `turno session list\|handoff <p> [--fork]` | open sessions, and the command to continue this one under another profile |
| `turno open [profile] <url>` | open a link; claude.ai links use that profile's Chrome profile |
| `turno identity list\|add\|remove\|login\|prefer\|log` | service accounts for the bridge, browser identities |
| `turno secret set\|has\|rm\|list` | MCP secrets in the macOS Keychain |
| `turno browser bench` | how automation-fingerprint test pages see each browser engine |
| `turno ui status\|install` | the status line, its font and icons in every terminal |
| `turno doctor [--fix]` | check everything and repair what is safe to repair |
| `turno config path\|get\|set\|unset\|edit\|check` | config.toml without losing its comments |
| `turno undo [--list] [<stamp>\|last]` | put back the files a command changed |
| `turno upgrade [--check]`, `turno version` | update turno the way it was installed |
| `turno completion zsh\|bash\|fish` | shell completion, including profiles and config keys |

### Config

`~/.config/turno/config.toml`:

```toml
system = "personal"     # account the plain `claude` command uses
default = "personal"    # profile for folders without a rule
# fallback = "work"     # optional, off unless set; read "Vendor terms" first

[profiles.work]
color = "violet"        # status line pill
[profiles.personal]
browser = "default"     # claude.ai links open in the default browser
[profiles.cx]
agent = "codex"

[[projects]]
path = "~/code/acme"
profile = "work"
```

### MCP gateway

`~/.config/turno/mcp.toml`:

```toml
[server.calendar]
command = "cal-mcp"
package = "@calcom/cal-mcp@1.4.0"   # `turno mcp install` pins it instead of npx per start
env = { CAL_API_KEY = "keychain:turno/calendar/api-key" }
scope = "shared"                     # one process for every session

[server.devtools]
command = "chrome-devtools-mcp"
scope = "session"                    # one per agent session, stopped when it ends
idle = "15m"

[server.issues]
command = "issues-mcp"
[server.issues.variant.work]         # the work profile reaches a different account
env = { ISSUES_TOKEN = "keychain:turno/issues/work" }

[server.docs]
url = "https://docs.example.com/mcp" # remote, written straight into each profile
```

Each variant per profile runs separately, so two profiles can reach two accounts of the same
service. Details: [docs/mcp.md](docs/mcp.md).

### Browser with real profiles

```sh
npm install --global turno-browser   # optional
turno identity add browser:school    # an identity and its mcp.toml entry
turno identity login browser:school  # sign in by hand once; cookies persist
```

It drives the installed Google Chrome, headed, with a persistent profile per identity and no
injected scripts ([ADR 0005](docs/decisions/0005-stealth-browser-defaults.md)).

**Acceptable use.** Use it with your own accounts, on sites whose terms allow automated access
by you, and at a human pace. Do not use it to get around access controls, paywalls, CAPTCHAs or
rate limits, to scrape at scale, or to access accounts that are not yours.

### Accounts bridge

A builtin MCP server (`builtin = "accounts"` in `mcp.toml`) lets a session in one profile
delegate a task to a service account (a Linear workspace, a mail connector) that only another
profile is signed into. Write tasks need your confirmation, and every call goes to an audit log
(`turno identity log`).

### Status line

![The turno status line with Nerd Font icons and with Unicode icons](docs/assets/statusline.png)

```sh
turno ui install                     # font + statusLine in the shared settings.json
turno ui install --terminal current  # also set the font in this terminal
```

Row 1: profile and plan, 5 h and weekly usage of that account with time to reset, context, and
a warning when the folder belongs to another profile. Row 2: project and worktree, branch, lines
changed, model and effort, and the API-equivalent cost of the conversation including subagents.
Details: [docs/ui.md](docs/ui.md).

### Claude Code plugin

`plugins/turno` adds session handoff and fork skills and a hook that records when a profile
reaches its usage limit, so `turno status` can show it:

```
/plugin marketplace add william-monroy/turno
/plugin install turno@turno
```

### Files

| Path | What |
|---|---|
| `~/.config/turno/config.toml` | profiles and folder rules |
| `~/.config/turno/mcp.toml` | MCP servers behind the gateway |
| `~/.config/turno/accounts.toml` | service accounts for the bridge |
| `~/.local/state/turno/` | usage, run records, logs, backups, the mcpd token |
| `~/.local/share/turno/` | installed servers, tool cache, browser identities |

All three honor `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_DATA_HOME`.

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

Issues labeled [good first issue](https://github.com/william-monroy/turno/labels/good%20first%20issue)
are a good start. Read [CONTRIBUTING.md](CONTRIBUTING.md), the
[Code of Conduct](CODE_OF_CONDUCT.md) and the [AI policy](AI_POLICY.md). Questions and ideas go
to [Discussions](https://github.com/william-monroy/turno/discussions) (there is an Español
category). Security issues: [SECURITY.md](SECURITY.md).

```sh
pnpm install && pnpm build
pnpm check       # typecheck, tests (sandboxed HOME), repository text rules, licenses
```

Design: [docs/design](docs/design/2026-11-12-claudio-ecosystem-design.md). Decisions:
[docs/decisions](docs/decisions/). Progress: [docs/STATUS.md](docs/STATUS.md).

## License

Apache License 2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)). The bundled fonts keep their own
licenses ([packages/fonts/LICENSE.txt](packages/fonts/LICENSE.txt)); dependencies are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Made in Monterrey, Mexico.

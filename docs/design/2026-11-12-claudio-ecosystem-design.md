# claudio ecosystem: design

Date: 2026-11-12
Status: approved for implementation (owner delegated all design decisions).
Amended by `docs/decisions/0004-builder-check-resolutions.md`, which wins where they differ
(notably: a `project` scope, PID-keyed `session` instances, enforced delegation, proxied remote
servers with Keychain headers, and `claudio statusline`).

## 1. Intent

Claude Code on a Mac becomes painful once you run several Claude accounts and many
sessions at the same time. The owner runs four accounts (personal, two companies, a
side business) and 15 to 20 parallel sessions (worktrees, agents, Orca panes). Three
problems drive this project:

1. **Accounts.** Each Claude account needs its own login, but sessions should share
   context (conversations, memory, skills, settings). The original `claudio` bash script
   already solves this with one `CLAUDE_CONFIG_DIR` per account and symlinks into a hub
   (`~/.claude`). It is hard-coded to one person.
2. **MCP overhead.** Every session spawns every local stdio MCP server at startup, whether
   it uses it or not. Measured on 2026-11-11: 18 sessions, 269 child processes, 11.7 GB of
   physical footprint for MCP servers alone, on a 16 GB machine with 14.3 of 15 GB swap
   used. A server like `chrome-devtools-mcp` costs 3 processes per session through `npx`.
3. **Detection and identities.** Stock Playwright is detected by many portals (leaks
   `Runtime.enable`, `navigator.webdriver`, automation flags, fresh profiles). Each service
   account (Linear workspace, Gmail, Cal.com key) should be bound to the right Claude
   account, and occasionally used from a session of another account.

The result should work for anyone with one or more Claude accounts on macOS, and be
publishable as open source. Personal data never lives in the repository.

## 2. Goals

- G1. Generalized multi-account launcher with feature parity with the original script:
  profiles, shared hub, per-project account resolution, fallback when an account is
  rate-limited, usage view, sessions view, opening claude.ai links in the right browser
  profile.
- G2. One local MCP gateway (`mcpd`) that every session talks to over HTTP. Stdio servers
  start lazily on first real use, are shared across sessions when stateless, isolated per
  session when stateful, and stop when idle or when their session dies.
- G3. Per-profile MCP accounts: the same server name can run with different credentials
  depending on which Claude account the session belongs to. Secrets come from the macOS
  Keychain.
- G4. Stealth browser automation with persistent identities (one browser profile per
  service identity), based on Patchright, exposed with the full Playwright MCP tool set.
  A benchmark command measures detection on public test pages and user-provided targets.
- G5. Account registry and bridge: list which service accounts exist, which Claude
  profile owns each, and delegate a task to the owning profile when the current session
  cannot reach that account directly. Audit log for every delegated call.
- G6. Packaged mods: status line, rate-limit hook, account-switch and fork skills, as a
  Claude Code plugin plus config written by `claudio setup`.
- G7. Safe migration from the original script and config, with backups.

## 3. Non-goals

- Windows or Linux support (macOS first; keep the code portable where cheap).
- Managing claude.ai connectors (Gmail, Drive) programmatically. Those live in each Claude
  account; claudio only documents and delegates to them.
- Sharing one Claude login across accounts or bypassing plan limits.
- A hosted service. Everything runs locally; nothing phones home.

## 4. Anti-goals

- Storing secrets in config files or in the repository.
- Breaking a running session: claudio never rewrites a profile's `.claude.json` while that
  profile has live sessions unless forced.
- Evading CAPTCHAs, identity checks, or anything aimed at accounts the user does not own.
  The stealth browser exists so legitimate automation of the user's own accounts is not
  blocked by generic bot heuristics.
- Exposing the gateway beyond `127.0.0.1`.

## 5. Constraints

- Node.js >= 20 (MCP SDK and Patchright live there). TypeScript, ESM, strict mode.
- Few runtime dependencies: `@modelcontextprotocol/sdk`, `smol-toml`, `patchright-core`
  (browser package only). CLI parsing with `node:util` `parseArgs`.
- Startup latency matters for `claudio auto` and `claudio resolve` (called by the status
  line). Keep these paths free of heavy imports.
- Must coexist with the original script until the owner's cutover.
- English everywhere in the repository. No em dashes. Conventional Commits.

## 6. Architecture

```
            Claude Code sessions (any profile)
   claude-work claude-personal claude-lab claude (hub)
        |            |             |            |
        |  .claude.json of each profile lists mcpd servers as type:http
        |  headers: Authorization, X-Claudio-Profile, X-Claudio-Pid
        v            v             v            v
   +-------------------- claudio mcpd (one process, launchd) -------------------+
   |  /mcp/<server>                                                              |
   |  - cached initialize/tools/list (no spawn until a real call)               |
   |  - instance key: shared (server, variant) | session (server, mcp session)  |
   |  - reaper: dead pid, idle timeout, exclusive leases                        |
   |  - builtin servers: accounts (registry + delegation)                       |
   +-----------+------------------+--------------------+------------------------+
               |                  |                    |
         stdio upstreams    stdio upstreams      claude -p (delegation)
         calcom, trigger    browser identities   under the owning profile
         codebase-memory    (patchright MCP)
```

Remote HTTP MCP servers (Neon, Granola, Linear, ...) are written directly into each
profile's config. They cost nothing locally, and OAuth tokens already live per profile.

### 6.1 Repository layout

```
claudio/
  packages/claudio/        npm package "claudio": CLI, core, mcpd, accounts
    src/core/              paths, config, profiles, keychain, process, fs helpers
    src/cli/               commands, launcher generation, legacy aliases
    src/mcpd/              gateway server, upstream manager, cache, reaper, builtins
    src/accounts/          registry, rules, delegation, audit
    test/                  vitest unit and integration tests, fixtures
  packages/browser/        npm package "@claudio/browser": stealth MCP wrapper, bench
  plugin/                  Claude Code plugin: status line, hooks, skills
  docs/design/             design documents
  docs/decisions/          decision records (ADR)
  docs/STATUS.md           progress log, next steps
```

### 6.2 Files on disk (user side)

| Path | Content |
|---|---|
| `~/.config/claudio/config.toml` | profiles, project rules, fallback, browser per profile |
| `~/.config/claudio/mcp.toml` | MCP server manifest |
| `~/.config/claudio/accounts.toml` | service account registry and folder preferences |
| `~/.local/state/claudio/` | usage snapshots, exhausted marks, session run records, mcpd token, logs, audit log |
| `~/.local/share/claudio/` | installed MCP servers, tool caches, browser identity profiles |
| `~/.claude-<profile>/` | Claude Code config dir per account (unchanged layout) |
| `~/.local/bin/claude-<profile>` | generated launchers (unchanged contract) |

All base paths honor `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME` and derive from
`HOME`, so tests run in a sandbox home.

## 7. Components

### 7.1 Core and CLI (G1, G7)

Port of the original script with the same behavior, English output and English command
names. Legacy Spanish names stay as hidden aliases so existing hooks, Orca and the status
line keep working during migration.

| Command | Legacy alias | Behavior |
|---|---|---|
| `claudio <profile> [args]` | | exec the profile launcher |
| `claudio auto [args]` | | resolve profile for `$PWD` (worktrees count as their main repo), honor fallback when exhausted, exec |
| `claudio which [dir]` | `cuenta` | explain the resolution |
| `claudio resolve [dir]` | `resolver` | machine output for the status line (`chosen\x1fassigned\x1freason\x1fnote`) |
| `claudio sessions` | `sesiones` | live sessions and their profile |
| `claudio usage [--watch]` | `uso` | 5 h and weekly usage bars per profile |
| `claudio exhausted <p> [until "YYYY-MM-DD HH:MM"]` | `agotada` | mark exhausted (default 5 h) |
| `claudio available <p>` | `disponible` | clear the mark |
| `claudio hook rate-limit` | `limite` | StopFailure hook: parse reset time, mark exhausted |
| `claudio setup <p>...` | | create or repair profile dirs, symlinks, launchers |
| `claudio status` | | profiles, accounts, sharing health |
| `claudio open [p] <url>` | `abrir` | claude.ai links in the profile's isolated Chrome profile or default browser |
| `claudio migrate` | | import legacy `proyectos`/`navegador`/state into the new layout, with backup |
| `claudio doctor` | | environment checks (node, claude, Chrome, mcpd, launchd, config) |

Launchers keep the original contract and add two exports used by mcpd:
`CLAUDIO_PROFILE=<name>` and `CLAUDIO_SESSION_PID=$$` (the PID survives `exec`).
`claudio-auto` and the `$BROWSER` launcher are still generated; the browser launcher is
named `claudio-open`, and `claudio-navegador` is kept as a compatibility symlink when it
already exists.

Profile discovery rule (fix from 2026-11-11): a profile is a `~/.claude-<name>` directory
that has its `claude-<name>` launcher, or is declared in `config.toml`.

### 7.2 MCP gateway, `mcpd` (G2, G3)

Manifest example:

```toml
[server.calcom]
command = "cal-mcp"
env = { CALCOM_API_KEY = "keychain:claudio/calcom" }
scope = "shared"          # shared | project | session
idle = "15m"

[server.calcom.variant.work]            # profile "work" uses another account
env = { CALCOM_API_KEY = "keychain:claudio/calcom-work" }

[server.chrome-devtools]
command = "chrome-devtools-mcp"
scope = "session"
idle = "20m"
profiles = ["work", "lab"]               # default ["*"]

[server.neon]
url = "https://mcp.neon.tech/mcp"       # remote: written directly into profiles
```

Behavior:

- **Transport.** Streamable HTTP on `127.0.0.1:<port>` (default 47821), one path per
  server: `/mcp/<name>`. Requests must carry `Authorization: Bearer <token>` (token in
  `~/.local/state/claudio/mcpd.token`, mode 600, written literally into each profile
  config by `claudio mcp sync`). Requests with a non-local `Host` or any `Origin` header
  are rejected (DNS rebinding protection).
- **Session identity.** `X-Claudio-Profile` is written literally per profile.
  `X-Claudio-Pid: ${CLAUDIO_SESSION_PID:-0}` is expanded by Claude Code at connect time
  (verified on 2026-11-12 with a probe server).
- **Lazy start.** `initialize`, `tools/list`, `resources/list`, `resources/templates/list`
  and `prompts/list` are answered from a cache (`~/.local/share/claudio/mcpd/cache/<server>.json`)
  keyed by a fingerprint of command, args, env names and package version. A missing or
  stale cache triggers one upstream start to fill it. Any other request starts the
  upstream instance if needed and forwards it.
- **Instance keys.** `shared`: one upstream per `(server, variant)`; the variant is the
  profile name when that profile has a `variant` block, else `default`. `session`: one
  upstream per MCP session id. `exclusive = true` (used by browser identities) grants a
  shared instance to one client session at a time; other sessions get a clear tool error
  naming the holder, and the lease ends after the holder is idle for `lease` (default 5m)
  or its PID dies.
- **Reaper.** Every 15 s: stop session instances whose PID is dead or whose MCP session
  was deleted; stop any instance idle longer than `idle`.
- **Forwarding.** Requests, notifications (progress, list_changed, logging) and
  server-to-client requests (roots, elicitation, sampling) are relayed in both directions
  through the MCP SDK. When an upstream reports a different tool list than the cache, the
  cache is updated and clients get `notifications/tools/list_changed`.
- **Secrets.** `keychain:<service>` values resolve through `security find-generic-password
  -s <service> -w` at spawn time inside mcpd, never logged. `env:<NAME>` reads mcpd's env.
- **Lifecycle.** `claudio mcpd run` (foreground), `start|stop|restart|status|logs` manage a
  LaunchAgent (`dev.claudio.mcpd`). `status` lists running upstreams with PID, RSS,
  clients and idle time.
- **Config sync.** `claudio mcp sync [profile]` writes each profile's `mcpServers`:
  gateway entries for stdio servers, direct entries for remote servers, and removes entries
  it wrote earlier that left the manifest (tracked in state, never touching servers it did
  not create). Busy profiles are skipped unless `--force`. The hub config (`~/.claude.json`)
  is treated as the profile named by `system`.
- **Import.** `claudio mcp import` drafts `mcp.toml` from the hub `mcpServers` and lists
  plugin-provided stdio servers that bypass the gateway (`claudio mcp doctor` explains how
  to disable them and declare them in the manifest instead).
- **Install.** A server may declare `package = "chrome-devtools-mcp@0.9.0"`; `claudio mcp
  install` installs it under `~/.local/share/claudio/servers/<name>` and resolves `command`
  there, removing the `npx` wrapper process and the network check at every start.

### 7.3 Stealth browser (G4)

`patchright-core` ships the complete Playwright MCP program (`lib/entry/mcp.js`) built on
the patched driver, so the browser package does not reimplement tools. It provides:

- `claudio-browser-mcp [--identity <id>] [playwright-mcp flags]`: runs the Patchright MCP
  with stealth defaults: real Chrome channel, headed, persistent user data dir
  `~/.local/share/claudio/browser/identities/<id>` when an identity is given, otherwise an
  isolated temporary profile.
- Manifest integration: each identity is a server (`browser-<id>`) with `scope = "shared"`
  and `exclusive = true`, so one Chrome per identity serves one session at a time. A plain
  `browser` server with `scope = "session"` covers throwaway automation.
- `claudio browser login <id>`: opens that identity's Chrome so the user signs in once by
  hand (refuses while mcpd holds the identity).
- `claudio browser bench [--engine ...] [--url ...]`: runs engines (patchright-chrome
  headed and headless, stock playwright for comparison, camoufox when installed) against
  public detectors (rebrowser bot detector for CDP leaks, sannysoft, CreepJS) and the
  user's targets; prints a pass/fail table and writes JSON.

### 7.4 Accounts registry and bridge (G5)

```toml
[account."linear:work"]
service = "linear"
profile = "work"                     # owning Claude profile
tools = ["mcp__linear__*"]           # tool pattern that reaches it inside that profile

[account."gmail:personal"]
service = "gmail"
profile = "personal"
tools = ["mcp__claude_ai_Gmail__*"]

[[prefer]]
path = "~/code/acme"
linear = "linear:work"
```

The builtin `accounts` server (inside mcpd, no process) exposes:

- `accounts_list`: accounts, owners, whether each is native in the calling profile, and the
  preferred account per service for the session's roots (asked from the client via
  `roots/list`).
- `accounts_delegate(account, task, write)`: runs the task headless in the owning
  profile (`claude-<profile> -p --output-format json --allowedTools <tools>`), with a
  timeout, and returns the result. `write = true` (outward-facing actions: sending,
  creating, posting) requires `confirmed_by_user = true`, otherwise it returns the plan the
  caller must confirm with the user first. Every call is appended to
  `~/.local/state/claudio/audit.jsonl`.

Live sessions already message each other through Claude Code's shared `sessions/`
registry (SendMessage); the bridge covers the headless case.

### 7.5 Mods plugin (G6)

`plugin/` is a Claude Code plugin with the rate-limit hook, the status line script
(generalized: colors and icons from `config.toml`), and the account-switch and fork
skills generalized to read profiles from config. `claudio setup` points `statusLine` at
the plugin script. Personal hooks unrelated to accounts stay in the owner's dotfiles.

## 8. Testing

- Unit: config parsing and defaults, resolution (longest prefix, worktree to main repo,
  fallback when exhausted), rate-limit message parsing (all formats the original parser
  handled), launcher text, `mcp sync` transformation and ownership tracking, cache
  fingerprints.
- Integration (mcpd): a fixture stdio MCP server with an echo tool, a counter tool (state)
  and a `whoami` tool (env); SDK clients over HTTP verify: lists without spawn, spawn on
  call, sharing across clients, variants per profile, session isolation, reap on PID
  death and idle, exclusive leases, auth and Origin rejection, list_changed propagation.
- End-to-end in a sandbox `HOME`: `claudio setup`, launchers, `claude mcp list` against a
  live mcpd with the real `claude` binary.
- Browser: smoke test that the wrapper starts and lists tools; bench runs manually
  (network and Chrome required).

## 9. Migration (owner's machine)

1. Build and link the CLI under a different name until cutover (`claudio-next`).
2. `claudio migrate` copies legacy config into TOML and state into XDG dirs (originals kept).
3. `claudio mcp import`, review, `claudio mcp install`, `claudio mcpd start`.
4. Cutover (needs the owner, because live sessions must close): disable plugin stdio
   servers covered by the manifest, `claudio mcp sync` for every profile, regenerate
   launchers, swap `~/.local/bin/claudio`, point the status line at the plugin.
5. Rollback: backups of every touched file under `~/.local/state/claudio/backups/<stamp>/`
   and `claudio migrate --rollback <stamp>`.

## 10. Left to the builder

- Exact internal module boundaries and helper names.
- Port number fallback if 47821 is taken (pick next free, persist in state).
- Formatting of tables and colors.

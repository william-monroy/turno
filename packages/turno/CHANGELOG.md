# turno-cli

## 0.2.0

### Minor Changes

- 8922b9d: `turno doctor` names the fix for every finding. Each warning and failure is followed by the
  command that fixes it (`fix: turno profile repair work`, marked when `turno doctor --fix` runs it)
  or the manual step, in sections (System, Config, Profiles, MCP, Look, Gateway) with icons and a
  summary line (`12 ok, 2 warnings, 1 failure in 340ms`). `--json` adds `status`, `fix`, `auto` and
  `manual` per check and `counts`, `ms` and `next` at the top. `--summary` prints one line for hooks
  and status lines. `turno doctor --security` works the same way.
- 3dee471: Syntax highlighting in a terminal, with no new dependencies.
  
  - `turno init` shows the `config.toml` diff and the new `mcp.toml` with TOML colors: table headers bold, keys cyan, strings green, numbers, booleans and dates magenta, comments dim. The `+` and `-` markers keep their green and red, and removed lines stay plain red.
  - `turno mcp import` colors its preview the same way, and a masked secret (the lines marked `# secret, hidden`) shows in yellow so it stands out. `turno mcp config` colors the JSON snippet and dims the file and note lines. `turno config set` colors the `key = value` it prints.
  - `--json` output is colored when it goes to a terminal: keys cyan, strings green, numbers, booleans and null magenta. Piped into `jq` or a file it stays plain JSON, even with `FORCE_COLOR` set.
  - Colors follow one rule everywhere: only on a terminal, never with `NO_COLOR` set. `FORCE_COLOR=1` now colors output that is not a terminal (for example `turno ... | less -R`), and `FORCE_COLOR=0` turns colors off on a terminal (`--json` is the exception: never colored outside a terminal). Output without colors is unchanged byte for byte.
- 7d2eea1: Bare `turno` now shows the status screen once turno is set up (the help before that), and `turno status` ends with the one thing to do next (`turno init`, `turno profile repair <p>`, `turno mcp daemon start`, `turno mcp sync`, `turno upgrade` or `turno ui install`); `status --json` has it as `next`. `turno init` also offers to start the gateway and point every profile at it in the same run and the same journal (asked in a terminal; `--start` with `--yes`, `--no-start` to skip), and ends with the command to try.
- a471bba: turno never waits for an answer nobody can give.
  
  - A global `--no-input` flag (before or after the command) and `TURNO_NO_INPUT=1` turn every question off. turno also asks nothing inside a coding agent's session: Claude Code (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`), Codex (`CODEX_THREAD_ID`, `CODEX_SANDBOX`), Copilot CLI (`COPILOT_CLI`, `COPILOT_AGENT_SESSION_ID`) and Cursor (`CURSOR_AGENT`). `TURNO_NO_INPUT=0` allows questions again, for an editor terminal that sets one of those variables. Without a terminal there were no questions already.
  - A command that needs an answer then exits with code 2 (`init`, `uninstall` and `profile add` used 1) and names the flag that gives it, in one format: `turno: init needs an answer; pass --yes (or run it in a terminal)`. This covers `turno init`, `turno profile add` and `turno profile repair` (moving your own files aside), `turno uninstall`, `turno browser bench`, and `turno secret set`, which no longer shows its hidden prompt and asks for the value on stdin instead. `turno upgrade --finish` does not ask about `turno mcp sync` and names it instead.
  - `turno help` mentions `--no-input`.
- 0a8f185: Choose a profile from a list when a command needs one and you leave it out: `turno profile assign [dir]`, `turno profile remove` (then a y/N confirmation), `turno run`, `turno session handoff`, `turno limit set` and `clear`, and `turno open <claude.ai link>` outside a profile's session. The list shows each profile as its colored pill with its agent and account, marks the one this folder uses and the exhausted ones, and takes arrow keys or j/k, typing to filter, Enter, and Esc or Ctrl-C to cancel (exit 130, nothing changed). It draws on stderr and always puts the terminal back. Without a terminal, with `--no-input` or inside an agent session, those commands exit with 2 and list the valid values (`pass a profile: personal, work`). `turno profile list` and `turno session list` are restyled: pills in each profile's color, aligned columns, accounts, how many folders use each profile, and each session's age; plain output (a pipe, NO_COLOR) keeps one row per item starting with its name. `--json` output is unchanged.
- 4dd7d66: The new look reaches more screens, and colors get one switch.
  
  - `turno limit show` draws each profile as its colored pill with the account, a usage bar per window colored by level, the reset time, `used up` when a window is full and a red mark while a profile is marked exhausted.
  - `turno mcp list` is a table with server, kind, scope, idle time, profiles (as pills), state (running or stopped in mcpd, or direct), auth (oauth login state, or `secret` when it uses a keychain or env reference) and the details (command or URL, variants, package, tool filters, logins). On a terminal the column titles are muted lowercase, paths are shortened to `~`, the details wrap under their own column and a narrow terminal drops the secondary columns first; nothing runs past the terminal width. It says once when mcpd is not running.
  - `turno mcp top` and `turno mcp log` line up their columns, right-align numbers, show running icons and color the outcome of each call (ok, error, timeout, cancelled), calls in flight, restarts and errors. On a terminal `mcp log` shows only the time when every call is from today, fits each line to the width (long names end in `…`, the agent and then the sizes go first on a narrow terminal) and puts an error on its own line; piped output keeps its columns.
  - On a terminal, a word longer than the line (a long path) is cut at the width instead of running past it.
  - `turno identity list` has sections (service accounts, folder preferences, browser identities) with aligned rows, profile pills and the confirm policy under each account.
  - A global `--color auto|always|never` and `TURNO_COLOR`. Order: `--color`, then `TURNO_COLOR`, then `NO_COLOR`, then `FORCE_COLOR`, then whether output is a terminal. `--json` stays plain outside a terminal whatever the flag says.
  - The status line pill and every other profile pill use one color rule.
  - `turno demo` without a terminal (a pipe, `--no-input`, an agent) prints what it set up and ends instead of waiting for Ctrl-C forever; `--keep` keeps it running until Ctrl-C (also in a terminal, instead of opening a shell).
- c5b23f5: A visual language for the CLI. `turno` and `turno status` now show sections (Here, Profiles, Machine), each profile as a pill in its own status line color, usage bars colored by level with the time to reset, a gateway icon, and a prominent Next row. `turno help` has section headers, commands in the accent color, an Examples block, and fits the terminal width. `turno init` prints its phases (Found, Plan, Write, Gateway, Sync) with a spinner while the gateway starts, a checklist of synced profiles, the time it took, and a `Try it:` line naming the launcher of the profile the current folder opens. `turno mcp sync` prints one aligned row per config and its timing. `turno undo` sums up each folder in one line (for example `~/.claude-work  23 links removed, settings.json moved back`) and lists every change with `-v`. Tables follow the real terminal width (COLUMNS, then the terminal, 80 otherwise). Without colors (a pipe, NO_COLOR) the same layout prints as plain text with ASCII icons; `--json` output is unchanged. Paths under HOME show as `~` even when HOME has a trailing or doubled slash.
- f849d28: The Claude Code plugin (0.2.0) adds a third skill, `copy-artifact`: it copies a claude.ai artifact (an HTML page, or one made from a type such as a Design canvas, a deck or a document) from one turno profile's account to another, with its own files and its assets (fonts, images). Export runs in a session of the owning profile and packs everything into `~/.cache/turno/artifacts/`; import runs in a session of the target profile, uploads the assets, rewrites the `/_blob/` references and publishes a new artifact. Two dependency-free Node scripts do the packing and the rewriting, and fail loudly on a missing file, a path outside the source folder, an asset no file cites, a cited asset that was not passed, an unknown id or a count that differs from the manifest. Comments, the artifact's database and its version history do not travel; sharing from the Share menu stays the way to edit one artifact from both accounts.
- 6d7926a: Pick which MCP servers each folder sees, and a round of follow-ups:
  
  - A `[[projects]]` rule in config.toml can carry `mcp = ["issues", "docs"]` (only these
    servers) and `mcp_deny = ["mail"]` (not these), with or without a `profile`. mcpd hides the
    other servers from sessions in that folder: they show no tools, refuse calls and never start.
    A git worktree follows its main repository's rule. mcpd now reloads config.toml when it
    changes or on SIGHUP. `turno config check` warns about server names that are not in mcp.toml
    and about direct remote servers a set cannot hide, `turno profile which` shows a folder's set,
    and `profile assign`, `unassign` and `remove` keep it.
  - `turno upgrade --finish` offers to run `turno mcp sync` when agent configs need a new gateway
    token (it asks in a terminal; `--yes` runs it), and records the launchers it rewrites so
    `turno undo` can put them back.
  - `turno mcp sync` removes the token files it wrote for profiles that no longer exist.
  - `turno mcp list` shows each server's tool filters (allow and deny), also per variant.
  - Changing a server's tool filter no longer restarts its process.
  - `turno doctor` warns about accounts in accounts.toml without `read_tools`, and
    `turno doctor --security` counts the profile tokens next to the token age and warns about
    token files older than the current gateway token.
  - `turno mcp install` keeps `servers/<name>/` private (mode 700).
  - mcpd applies `call_log` changes without a restart, and sessions it rebuilds after a restart
    keep their agent's name in the call log.
  - `turno undo` of `profile add` puts back the previous mode of a profile folder that existed.
- 48453b4: mcpd can now log in to remote MCP servers that use OAuth, once per account, for every agent and profile.
  
  - Declare a remote server with `auth = "oauth"` in `mcp.toml`. mcpd proxies it and adds the access token itself, so no agent logs in on its own. A profile that needs another account gets `[server.<name>.variant.<profile>]`; every other profile shares the default login.
  - New `turno mcp login <server> [--profile p]`: finds the authorization server, registers turno (your own `client_id`, a client ID metadata document you host, or dynamic registration), and runs a PKCE login in the browser with a loopback redirect. `--no-browser` prints the link, `--dry-run` shows the plan, `--scope` asks for more scopes.
  - New `turno mcp logout <server> [--profile p | --all]`: revokes the token at the server when it can and deletes it.
  - Tokens are kept only in the Keychain or Secret Service (`turno/oauth/<server>@<variant>`), never in files or logs. mcpd refreshes them when they expire or the server answers 401, and saves a rotated refresh token before using the new access token; if the Keychain refuses that write, mcpd keeps the token in memory and retries instead of losing it.
  - When a login is missing or was revoked, calls fail with the `turno mcp login` command to run, and `turno mcp list`, `turno mcp doctor` and `turno doctor` show it.
- cfe036e: See what the gateway does and what it saves:
  
  - `turno mcp log [-f] [-n N] [--server S] [--profile P] [--json]` shows the tool calls mcpd
    relayed: time, outcome (ok, error, cancelled, timeout), duration, server and variant, tool,
    profile, agent and request and response sizes. mcpd keeps them in
    `~/.local/state/turno/logs/calls.jsonl` (mode 600, rotated at 5 MiB). Records never hold the
    call's arguments or result, and error texts have tokens redacted. Turn it off with
    `call_log = false` under `[mcpd]` in config.toml.
  - `turno mcp top [--once] [--json]` shows each running server's memory (with its child
    processes), sessions, calls in flight, idle time and restarts, refreshing every 2 seconds in a
    terminal.
  - `turno mcp savings [--json]` compares the memory of mcpd and its servers with an estimate of the
    same agent sessions without the gateway (sessions x per-server memory).
  - The mcpd `/status` endpoint now lists the agent sessions and each instance's restarts.
- 91b3a76: Set turno up in one step, or try it without touching your setup.
  
  - New `turno init [--dry-run] [--yes]`: finds the agents on your PATH, your turno profiles, agent folders you made by hand (`~/.claude-work`, `~/.codex-cx`, ...), the MCP servers in your Claude Code, Codex, Cursor and Copilot CLI configs, and the folders each Claude Code account was used in. It proposes profiles, folder rules, a default profile and `mcp.toml`, prints everything (with the `config.toml` diff, the new `mcp.toml` with secrets masked, and any of your files it would move aside), asks, and writes it all as one change that one `turno undo` reverts. In a terminal it asks before adopting each folder; without one it needs `--yes`. `--profile <name[:agent]>`, `--skip <name>`, `--default <profile>` and `--no-mcp` answer the questions from the command line. It ends with what is left: signing in once per profile, `turno mcp daemon start`, `turno mcp sync` and `turno ui install`.
  - New `turno demo` (also `npx turno-cli demo`, no install needed): builds a throwaway HOME in the temp folder with two Claude Code profiles, a folder rule, two small MCP servers behind a gateway on a free port, and the status line, then opens a shell there (`turno demo -- <command>` runs one command instead). It never reads or changes your own HOME and never signs in. When you leave, or press Ctrl-C while it waits, it stops the gateway and removes the folder.
  - `turno help` starts with `turno init` and `turno demo`; `init` and `demo` can no longer be profile names.
- d05b5b9: mcpd speaks MCP 2026-07-28 next to 2025-11-25, and stops idle servers sooner when memory is low:
  
  - Agents that use the stateless 2026-07-28 revision (no `initialize`, no session id,
    `Mcp-Method` and `Mcp-Name` headers) are served directly instead of falling back to a
    2025-11-25 session: `server/discover`, cached `tools/list`, `prompts/list` and
    `resources/templates/list` with `ttlMs` and `cacheScope`, relayed calls with progress and
    cancellation, and `subscriptions/listen` for list changes and resource updates. Headers that
    disagree with the body are refused as the revision requires. 2025-11-25 sessions work as
    before. Elicitation and sampling still need a 2025-11-25 session.
  - When the machine is short of memory (macOS memory pressure, Linux PSI, else free memory), idle
    MCP servers stop after `idle_under_pressure` (default 5 minutes, a quarter of it when pressure
    is critical) instead of their usual 20 or 30 minutes. Set it under `[mcpd]` in config.toml or
    with `turno config set mcpd.idle_under_pressure 10m`; `false` turns it off. Session servers
    whose agent still runs are kept.
- e424894: The accounts bridge no longer trusts the calling model to say what a delegated run may do:
  
  - Accounts take `read_tools` (`turno identity add ... --read-tools <patterns>`). A delegated read gets only those tools, so it cannot send, post or delete even if injected text tells it to; Claude Code refuses anything else, and the refused tools are reported.
  - Accounts take `confirm = "always" | "writes" | "never"` (`--confirm`). The default is `always` for mail and messaging services (every call asks the user) and `writes` elsewhere. A read of an account without `read_tools` is now confirmed like a write: add `read_tools` to keep unconfirmed reads.
  - The headless run starts in turno's own empty folder instead of the caller's, loads no settings files (`--setting-sources ""`), gets a minimal environment, and loads only the account's MCP servers (`--strict-mcp-config`) when they go through the turno gateway.
  - The result comes back marked as data from another account and capped at 20,000 characters.
  - Every audit log line records the decision: policy, whether the user was asked and the answer, the allowed tools, the MCP mode and refused tools. `turno identity list` shows each account's policy and `turno identity log` shows the decisions.
- b8d15ec: `turno doctor` names the fix for config.toml findings: `turno profile add <name>` for a profile that does not exist, else the line of config.toml to edit and what to write there (`turno config check` prints the same advice). A local server in `~/.claude.json` that mcp.toml serves runs outside mcpd until `turno mcp sync` replaces its entry, and `turno doctor --fix` now runs that sync. `turno doctor` reports the `env:NAME` and `${NAME}` references of mcp.toml that mcpd would resolve and that are not set, by name only, and checks the gateway token in every profile's config even without `mcp-managed.json`. `turno run` without a profile lists `auto` first in the picker, named with the profile the folder resolves to (`auto (work)`). `turno uninstall --purge` also removes turno's state, caches and installed MCP servers after the same confirmation (no undo after it); without `--purge` nothing changes. Faster: the status line, `turno auto` and `turno resolve` find a worktree's main repository by reading `.git` files instead of running git, and `turno doctor --summary`, `turno uninstall` and `turno mcp log` no longer load the gateway or the MCP SDK.
- 7e58586: `turno mcp` commands are safer and clearer:
  
  - Every `turno mcp` subcommand rejects unknown flags (`turno: unknown option --dryrun`, exit 2)
    and `--help` only prints usage. `mcp doctor`, `mcp list` and `mcp config` take `--json`;
    `mcp sync`, `mcp install` and `mcp refresh` take `--dry-run`.
  - `mcp sync` no longer rewrites `~/.claude.json` while a plain `claude` session is open (use
    `--force`), reads open sessions only from its own HOME, warns when mcpd is not running, does
    not create the gateway token in a dry run, and prints `undo with:` only when something changed.
    The hub config is labeled "plain claude (~/.claude.json)".
  - `mcp import` previews without side effects and with secrets masked, ends with the command that
    writes it, and accepts `--dry-run`. It also reads project servers in `~/.claude.json`, the
    folder's `.mcp.json`, Codex, Cursor and Copilot CLI configs, and says so when it finds none.
    `${VAR}` and `${VAR:-default}` become `env:VAR` references (the new `env:VAR:-default` form
    is resolved by mcpd); a placeholder is never stored in the Keychain. Secrets in args and URL
    query strings are detected and hidden.
  - `mcp install` pins each package to an exact version in `mcp.toml`, installs without install
    scripts (`--allow-scripts` to allow them) and keeps a lockfile per server for reproducible
    reinstalls.
  - `mcp refresh` asks a running mcpd to relearn a server's tools, and falls back to the restart
    hint with an older daemon.
- d89904d: First-run fixes for the command line.
  
  - `turno auto` never switches accounts in silence: a missing launcher, a rule naming a missing profile or a broken `config.toml` stop it with exit 1 and the command that fixes it (`TURNO_ALLOW_PLAIN=1` runs the plain agent despite a broken config). `system = ""` means "no default account": folders without a rule are an error too. `turno auto --agent codex` says when it runs plain `codex`.
  - `turno profile which` and `turno status` show the folder's profile for every agent with profiles.
  - `turno config set` checks values the way `profile add` does (profiles must exist and run the right agent, colors and enums must be valid; exit 2), and `config set fallback` reminds that the fallback is opt-in. `config.toml` errors show `~` paths and explain an unclosed string. Unknown keys and rules or roles that name missing profiles are listed by `turno doctor` and `turno config check`, with a suggestion for typos. New keys `agents.<agent>.default` and `agents.<agent>.fallback`.
  - Typos: `turno --verison` is an unknown option, `turno stauts` suggests `turno status`, `turno profile lst` suggests `turno profile list`.
  - One help path: `turno <command> --help`, `turno <command> <sub> --help` and `turno help <command> [sub]` print the usage on stdout with exit 0, and `--help` anywhere never runs the command. Help wraps at 80 columns. The main help starts with what turno is and a "Start here" line; `migrate` and the older names are hidden (they still work), and `browser` moved to a "Developer tools" section. `turno ui` is a regular command group (`turno ui install --help` works).
  - Launchers stop with `turno: claude is not installed (...)` when the agent is missing, export `BROWSER` only where `turno-open` can work (macOS, or Linux with `xdg-open`), and point at the `turno` on your PATH when there is one. Running from npx's cache, commands that would write its path (`profile add`, `profile repair`, `ui install`) refuse and ask you to install turno first.
  - `profile add` and `doctor` warn when `~/.local/bin` is not on your PATH, with the line to add, and suggest `turno <name>` meanwhile. `doctor` lists all four agents and fails only for one a profile uses; `profile add --agent X` warns when X is not installed.
  - `profile add` and `profile repair` print one summary line for the shared folders (`-v` lists them) and ask before moving your own files to `.aside-<time>/` (`--yes` for scripts; without a terminal they stop and say so).
  - Strict flags on more commands (`session handoff`, `migrate`, `resolve`, `ui install`, identity subcommands): a mistyped flag is an error instead of being ignored. Completion of these flags comes from the same spec.
  - Empty states and wording: `turno limit` with no profiles says so, profiles without data say `no usage data yet`, plurals are right.
- 26577d5: The MCP gateway daemon is sturdier and runs on Linux.
  
  - `turno mcp daemon start|stop|restart|status` use a `systemd --user` unit on Linux and the LaunchAgent on macOS; without either you get one clear line instead of a stack trace, and `~/Library` is never created on Linux.
  - mcpd runs as a single instance and never moves to another port: if `mcpd.port` is busy it fails and names the process that holds it, in `mcp daemon status` and `doctor` too. `mcpd.port` is removed when mcpd stops.
  - A broken `mcp.toml` no longer keeps mcpd from starting: it serves the last valid copy (or no servers) and shows the error in `mcp daemon status` and `doctor`. A broken `config.toml` falls back to defaults.
  - `mcpd.log` rotates at 5 MiB, and socket or disk errors are logged instead of stopping the daemon.
  - The LaunchAgent runs as `Interactive`, prefers a stable `turno` or node path over a version manager's, restarts only after a failure, and is written through the journal (`turno undo` restores it). `mcp daemon start --dry-run` prints it; `mcp daemon stop` also removes it, so mcpd does not come back at login; `turno upgrade --finish` rewrites it and restarts mcpd.
  - `turno doctor` checks that the port is held by your own mcpd, that the service file points at paths that exist, that synced profiles use mcpd's port, and that the token file is mode 600.
  - New `turno mcp token rotate`. The token file's mode is checked and fixed on every read.
  - `turno mcp daemon logs` shows local time (`--utc` for the raw lines).
  - `turno mcp daemon` rejects unknown flags and `--help` never runs an action.
  - `turno upgrade` accepts only a plain version from the registry or `--to`.
  - On Linux the client of a gateway connection is found from `/proc` when `lsof` is missing.
- c877e8a: MCP gateway: calls now always finish, and server requests reach the right session.
  
  - Pressing Esc on a slow tool, closing a session, or a new optional `call_timeout` per server
    now cancels the call on the server too, so idle servers stop again as they should. Cancelling
    an `accounts_delegate` run stops the other profile's process and records it as `cancelled`.
  - Editing `mcp.toml` applies to sessions that are already open (a rotated token, new args, a
    changed scope or idle time); a removed server says so instead of running the old definition.
  - On a shared server, a confirmation form or sampling request is sent only to the session whose
    call asked for it; when several sessions are mid-call, it is refused instead of guessed.
    Elicitation and sampling are offered to a server only when your client supports them.
    Project and session servers get `roots/list` answered from their folder, even at startup.
  - Folders with accents, CJK characters or emoji no longer break every gateway server: the
    launchers send the folder encoded (`X-Turno-Cwd-B64`; run `turno mcp sync` and `turno profile
    repair` to pick it up), and mcpd falls back to the session process folder.
  - Tool lists refresh by themselves after each server start and clients are told when they
    change; `resources/list` is no longer cached across projects. The gateway has a
    `POST /refresh/<server>` endpoint.
  - Remote proxies reconnect when the remote server forgets the session, and `type = "sse"` works.
  - Browser-like `session` servers stay up while their session lives; exclusive leases hold
    during long calls; request bodies up to 32 MiB; resource updates go only to subscribers;
    server logs rotate while running.
  - A server that keeps failing to start answers at once with the end of its log and is retried
    with backoff. After an mcpd restart, open conversations keep working instead of getting 404.
  - A declared `package` that is not installed still runs through npx, now with a warning that
    suggests `turno mcp install`.
- a84e56c: Security checks and hardening:
  
  - `turno doctor --security` checks who can read or write turno's folders (`--fix` narrows them
    to owner only), who holds the mcpd port, literal secrets left in `mcp.toml`, agent configs
    and backups (it names where, never the value), MCP servers that do not run an exact version,
    the age of the mcpd token and the audit log's hash chain. `turno doctor` shows which secret
    store `keychain:` references use.
  - `turno identity log --verify` (also `turno accounts log --verify`) checks the audit log's hash
    chain and exits 1 when it is broken; `log --json` lists the entries.
  - mcpd expands `${VAR}`, `${VAR:-default}` and `${env:VAR}` inside a stdio server's args and env
    values and a proxied server's headers, as Claude Code does. A missing variable stops that
    server with an error that names it, instead of passing the literal text.
  - `turno config set mcpd.max_request_body 64MiB` changes the largest request mcpd accepts
    (default 32 MiB).
  - Logs, marks, caches and state files turno writes are created 0600 in 0700 folders.
  - A secret store error prints one line instead of a stack trace; `turno mcp import
    --move-secrets` uses the secret store of the environment it runs in.
  - `turno status` says why mcpd is down (its last start error, who holds its port).
    `turno mcp daemon status` says "1 client session" and shows calls in flight per session.
    `turno usage` says why an account is unknown (claude missing, a timeout) instead of `? · ?`.
  - `turno mcp refresh` reports the instances mcpd could not refresh and exits 1.
- 7da71a8: mcpd follow-ups:
  
  - `turno mcp logout` tells a running mcpd, which stops using the old access token at once
    (it used to keep it for up to a minute). New admin endpoint: `POST /logout/<server>`.
  - When mcpd stops, it tries once more to save rotated OAuth tokens the secret store refused
    earlier, and logs the servers whose tokens are still lost.
  - `/status` reports the memory pressure (`memoryPressure`: level, idle cap, setting), and
    `turno mcp top` shows it in its header (and as `memoryPressure` in `--json`). A change to
    `mcpd.idle_under_pressure` in config.toml now applies without a restart.
  - Open sessions get `tools/list_changed` (and prompts and resources when the server is hidden
    or shown) when an `mcp.toml` tool filter or a folder's server set in config.toml changes
    what they see.
  - A call cancelled while its server is still starting is dropped instead of sent once the
    server is up.
- b3cfa89: A lighter default install and a locked dependency tree.
  
  - `npm install --global turno-cli` no longer pulls in `turno-browser` and `turno-fonts`
    (about 52 MB down to 27 MB). `turno ui install` downloads the status line font and checks
    each file against its pinned SHA-256. Install the browser package yourself when you want it:
    `npm install --global turno-browser`; `turno browser` and `turno identity` say so when it is
    missing, and find it in the global npm folder.
  - `turno-cli` and `turno-browser` ship an `npm-shrinkwrap.json`, so an install from npm gets
    exactly the dependency versions that were tested. No package in either tree runs an install
    script, and CI checks it.
  - `turno browser` is a developer diagnostic for browser engine compatibility. `browser bench`
    asks before it opens Chrome on third-party test pages, and without a terminal it needs
    `--yes` (`--json` alone no longer runs it). `--only-urls` replaces `--no-detectors`, which
    still works. `turno browser` and `turno identity` accept `--help` after any subcommand and
    reject unknown flags.
  - `turno-browser-mcp` refuses `--port` or `--host` together with `--identity`, which would
    serve a signed-in browser over HTTP; pass `--allow-http-identity` to accept that, and it then
    listens on 127.0.0.1 only.
  - An empty `turno identity` suggests `turno identity add ...` instead of the old
    `turno accounts add ...`.
- 43beccc: Each profile now has its own MCP gateway token, and servers can hide tools.
  
  - `turno mcp sync` writes each profile's own token into its agent config (derived from the master token), and plain `claude` gets the system profile's. mcpd takes the profile from the token, not from the `X-Turno-Profile` header: a profile cannot open a server limited to other profiles, and a header that names another profile is refused.
  - The master token in `mcpd.token` is no longer written into agent configs and only opens mcpd's own endpoints. **After upgrading, run `turno mcp sync` once**: configs synced by an older turno still send the master token, and mcpd refuses it for MCP sessions with a message that says so. `turno upgrade --finish` and `turno doctor` point it out too.
  - Codex, Copilot and Cursor launchers read their profile's token from `~/.local/state/turno/mcpd-tokens/<profile>.token` (mode 600, written by `turno mcp sync`). `turno mcp config --agent <a> --profile <p>` points other agents at that file.
  - `turno mcp token rotate` invalidates every profile token at once; run `turno mcp sync` afterwards.
  - New `tools = { allow = [...], deny = [...] }` in `mcp.toml`, per server and per profile variant (glob patterns). Filtered tools are not listed and calls to them fail with a clear error. `turno config check` validates them.
- 3f675f0: Security hardening of secrets, state files and `turno open`:
  
  - `turno secret set` and `turno mcp import --move-secrets` no longer pass the value as a command argument: on macOS it goes to `security -i` on stdin, so it never shows in the process list.
  - Linux: `turno secret set|has|rm|list` and `keychain:` references in `mcp.toml` use the Secret Service through libsecret's `secret-tool` (attributes `service=turno`, `account=<name>`). Without a secret store turno prints one line suggesting `env:` references instead of a stack trace.
  - turno's config, state and data folders are created with mode 0700 (existing ones are narrowed on first use), and the files turno writes there (`config.toml`, `mcp.toml`, `accounts.toml`, the audit log, backups) are 0600.
  - Backups made before each change are private (0700 folders, 0600 files) and pruned: writing a new backup deletes those older than 30 days, always keeping the newest 10 and any backup that is still the only way back for a file. `turno undo --prune [--older-than 30d] [--keep 10] [--dry-run]` prunes by hand.
  - The accounts bridge audit log is append-only and hash-chained: each line carries the hash of the line before it, so edits and deletions can be detected.
  - `turno open` accepts only http(s) and mailto links, refuses arguments that start with `-`, treats `--help` as help, and works on Linux (`xdg-open`; claude.ai links open in an isolated Chrome profile when `google-chrome`, `google-chrome-stable` or `chromium` is on PATH).
- f46b7c6: `turno undo` reverts a whole profile setup, and `turno uninstall` removes what turno set up.
  
  - `turno profile add` and `turno profile repair` now record the links, launchers and folders they create, the links and empty folders they replace, and the files they move to `.aside-<time>/`. `turno undo <stamp>` removes those links and launchers, moves your own files back, removes the `.aside-*` folder and the profile folder when it is empty again. A profile folder that holds a login (or anything made since) stays. `profile repair` prints its own `undo with:` line, and a launcher that did not change is no longer rewritten.
  - New `turno uninstall [--dry-run] [--yes] [--keep-config]`: stops mcpd and removes its LaunchAgent or systemd user unit, removes the MCP entries `turno mcp sync` added (your own entries stay), puts back the status line you had before `turno ui install` (or removes turno's), removes the launchers turno wrote, its fish completion file, the gateway token and `~/.config/turno` (kept with `--keep-config`). It prints the full list first, asks in a terminal and refuses without one unless `--yes`. Profile folders, browser profiles, backups and Keychain secrets stay and are listed; shell startup lines that load turno's completion are listed to remove by hand. The run is journaled, so `turno undo <stamp>` puts everything back while turno is still installed. The last line is the command that removes the package (`npm uninstall --global turno-cli`, or `brew uninstall turno`).

### Patch Changes

- c0b33e0: Neutral engine ids for `turno browser bench`, and a README demo of the current CLI.
  
  - `turno browser bench` names its engines by browser and mode: `chrome-headed`,
    `chrome-headless`, `chrome-baseline` and `firefox`. The old ids (`patchright-chrome-headed`,
    `patchright-chrome-headless`, `playwright-stock`, `camoufox`) are still accepted by `--engine`,
    and the report (table and `--json`) uses the new ones. turno-cli keeps working with an older
    turno-browser.
  - `turno doctor` and the status screen recognize turno's own status line when its path is
    quoted (as `turno demo` writes it), and show any other status line command without quotes,
    with ~ for your home folder and cut to fit the row.
  - The README demo is recorded from `turno demo` in a throwaway HOME and shows the status screen,
    `turno init --dry-run`, profiles, the profile picker, `turno doctor` with its fix lines,
    `turno mcp list` and `turno limit show`.
- d3c89cd: Faster help and startup, with the same output.
  
  - `turno --help` renders from a static table of command summaries and no longer loads every command module (about 3x faster).
  - `turno`, `turno status` and `turno mcp ...` no longer load the MCP SDK just to read the gateway's token, port and lock files, or to list OAuth logins.
  - `claude auth status` answers are kept for five minutes in turno's state folder, keyed by the profile's login files (`.claude.json`, `.credentials.json`), so `turno`, `turno status` and `turno profile list` no longer start one `claude` per profile on every run. Logging in or out asks again; failures are never kept.
  - `turno profile which` and `turno status` ask git for the folder's repository once instead of once per agent.
  - The CLI turns on Node's compile cache in `~/.cache/turno` (or `$XDG_CACHE_HOME/turno`); `NODE_COMPILE_CACHE` and `NODE_DISABLE_COMPILE_CACHE` work as for any Node program. `turno demo` runs without it, and `turno uninstall` lists the folder as one that stays.
- a53b716: `turno init` and `turno mcp import` now find MCP servers configured inside profile folders (`~/.claude-<name>`, `~/.codex-<name>`, ...), not only in each agent's main config. Previews (`turno init --dry-run`, `turno mcp import` without `--write`) no longer ask npm for command names; that lookup happens only when the manifest is written.
- ab12f13: `turno secret` refuses unknown flags and extra arguments, and `turno secret set --help` prints the usage instead of waiting for a value for a secret named `--help`.
- fb2fa3d: The status line no longer shows `$0.00` for models it has no price for: it shows Claude Code's own
  figure or `$?`. Prices were added for Claude Opus 4.5 and 4.1, Sonnet 4.5 and 4, the 3.x models,
  Mythos, and Bedrock or Vertex model ids; Fable 5.2, Sonnet 5.5 and Haiku 5.5 prices were corrected.
  A damaged cache file, an unexpected payload, a full disk or a read-only state folder now leaves one
  part of the line empty instead of replacing the whole line with an error. The plan is asked again
  every 10 minutes until it is known. The branch is read without running git, the status line cache
  is pruned after a week, and the line shows `mcpd down` when the MCP gateway the agents use does not
  answer.
- 55a2de1: Internal: each agent's differences now live in its adapter (ADR 0032), dead code is gone, and `pnpm check` lints with Biome and knip. No output changes for valid setups; an agent JSON config that is valid JSON but not an object is now reported instead of rewritten by `turno mcp sync`.

## 0.1.1

### Patch Changes

- d28b959: `turno upgrade` recognizes a Homebrew install and runs `brew update` and `brew upgrade turno`
  instead of `npm install --global`.
- ce52d03: The repository moved to `github.com/wimo-dev/turno`. turno-browser is listed in the MCP
  Registry as `io.github.wimo-dev/turno-browser`.

## 0.1.0

First public release.

- One MCP gateway (`mcpd`) for every agent session: tool lists from a cache, servers started on
  first use, shared between sessions where it is safe, stopped when idle, secrets in the macOS
  Keychain. `turno mcp import`, `install`, `sync`, `config` and `doctor` move existing servers
  behind it.
- Profiles for Claude Code, Codex CLI, GitHub Copilot CLI and Cursor CLI, each with its own
  login folder and launcher, and folder rules (`turno profile assign`, `turno auto
  [--agent]`). Claude Code profiles share conversations, skills and settings.
- Gateway entries for opencode, Gemini CLI, Goose, Crush, Droid and Kiro
  (`turno mcp config --agent <name>`).
- The Claude Code status line with usage per account, its font and terminal setup
  (`turno ui install`).
- The accounts bridge, a builtin MCP server that delegates a task to a service account another
  profile is signed into, with confirmation for writes and an audit log.
- `turno status`, `doctor --fix`, `--json` on reads, `--dry-run` and `turno undo` on writes,
  shell completion, `turno upgrade`, and a daily update check that honors `DO_NOT_TRACK`.

# 0030. `turno init` and `turno demo`

Date: 2026-11-16. Status: accepted.

## Context

The quick start takes about ten commands before turno does anything useful: `mcp import`
(preview, then `--write`), `profile add` once per account, `profile assign` per folder,
`config set default`, `mcp daemon start`, `mcp sync`, a sign-in per profile and `ui install`.
None of them says which comes next, and each writes its own journal, so trying turno and backing
out means several `turno undo` runs. A first-run review (02, ideas 1 and 3) proposed one command
that looks at the machine and proposes the whole setup, and a demo that shows turno working
without touching anything.

People who already use several accounts often have folders made by hand
(`CLAUDE_CONFIG_DIR=~/.claude-work`), MCP servers spread over Claude Code, Codex, Cursor and
Copilot configs, and a history of which account they used in which repository. That is enough to
propose profiles and folder rules instead of asking for them.

## Decision

**`turno init [--dry-run] [--yes] [--profile <name[:agent]>]... [--skip <name>]... [--default <p>] [--no-mcp]`**

- It detects: agents on PATH; turno profiles (and declared ones that are not set up, pointing at
  `profile repair`); agent folders made by hand, `~/.claude-<n>`, `~/.codex-<n>`,
  `~/.copilot-<n>`, `~/.cursor-<n>`, only when they hold a file that marks an agent home
  (`.claude.json`, `config.toml`, `cli-config.json`, ...), so `~/.cursor-server` or a skills
  folder is never offered; MCP servers in every agent config (the importer of `mcp import`,
  ADR 0020); and the `projects` of each Claude Code account's `.claude.json`.
- It proposes: a profile per folder found (two folders with the same name for different agents
  give one profile and a note), the profiles named with `--profile` (or, in a terminal with no
  profile at all, the names typed at a prompt, `work personal` by default), folder rules, a
  default (`--default`, or a prompt suggesting `personal`), and `mcp.toml` when there is none.
  An existing `mcp.toml` is kept as it is.
- Folder rules: a folder under HOME used by exactly one profile gets a rule. Two or more such
  folders side by side become one rule for their parent, unless the parent holds a folder of
  anyone else (another profile or the plain account) or is HOME. Folders an existing rule covers
  get none. The plain account (`~/.claude.json`) never gets rules; it only blocks.
- It prints what it found, each profile with the files it would move aside, a line diff of
  `config.toml` and the new `mcp.toml` with secrets masked (the import preview). In a terminal
  it asks per folder found (`[Y/n]`) and then "Write all of this?" (`[y/N]`). Without a terminal
  it refuses unless `--yes`; `--yes` adopts every folder found except `--skip`, as `profile add
  --yes` does (ADR 0021): the moves are listed in the plan, journaled and undone by `turno undo`.
- It writes through one journal named `init`: `config.toml` first (setup reads each profile's
  agent from it), `mcp.toml` (mode 600), then `setupProfiles` with that journal (ADR 0025), so
  `turno undo <stamp>` reverts all of it. Like `profile add`, it refuses to write launchers when
  turno runs from npx's cache.
- It does not start the gateway service, run `mcp sync` or install the status line. Those stay
  separate steps that init prints at the end, with the sign-in command of each new profile:
  the service is loaded into launchd or systemd (not something one journal can take back as a
  unit), and syncing agents to a gateway that is not running leaves them without MCP servers
  (02-H11). It also never moves secrets to the Keychain: a Keychain write is not journaled, so
  init keeps literal secrets in the 600 `mcp.toml`, warns, and names `turno mcp import --write
  --move-secrets --force`.

**`turno demo [-- <command> [args...]]`**

- Builds a HOME under the OS temp folder (`turno-demo-XXXXXX`, with a `.turno-demo` file holding
  the owner's PID) with: a `turno` shim that runs the CLI that started the demo, two Claude Code
  profiles (`work` violet, `personal` green and the default) set up by `setupProfiles`, a rule for
  `~/code/acme`, two MCP servers (`docs`, and `issues` with a `work` variant) served by a small
  stdio server shipped in the package (`dist/demo/server.js`, no network, no files), an mcpd
  started in-process on port 0 and written to `config.toml`, `mcp sync` run inside, and the
  status line in the hub `settings.json`. It prints the status line of both profiles and a list
  of commands to try.
- Everything inside runs with an env built from a short allow list (terminal, locale, PATH,
  TMPDIR, USER, SHELL): `HOME` is the demo folder, its `.local/bin` comes first on PATH, and no
  `XDG_*`, `TURNO_*`, `CLAUDE_*` or `ZDOTDIR` passes through. The status line state is seeded
  (plan, gateway health) so no background worker runs `claude auth status` or outlives the demo.
- In a terminal it opens an interactive shell (`$SHELL -i`, with a `.zshrc` and `.bashrc` that
  only set a prompt); exiting the shell ends the demo. With `--` it runs that command instead and
  returns its exit code. Otherwise it prints the `export HOME=... PATH=...` line for another
  terminal and waits for Ctrl-C.
- It always stops mcpd (which stops the servers) and removes the folder: when the shell or command
  exits, on SIGINT while waiting, on SIGTERM and SIGHUP (passed to the child first, killed after
  3 s), and as a last resort on process exit. Ctrl-C while a shell or command runs reaches that
  child from the terminal; the demo keeps waiting for it. A demo killed with SIGKILL leaves its
  folder, and the next demo removes any `turno-demo-*` folder whose owner PID is gone (folders
  without the owner file are never touched).
- It works from `npx turno-cli demo`: the shim and launchers point at the npx copy only for the
  life of the demo, so the npx refusal of `profile add` does not apply.

## Consequences

- The README quick start can become `turno init` (and `npx turno-cli demo` to look first); the
  ten commands stay documented for people who want each step.
- `init` and `demo` are reserved profile names.
- Rules come only from Claude Code history; Codex `[projects]` trust entries are not read yet.
- `turno demo` shows the gateway and the status line, but a tool call needs an MCP client. With
  Claude Code on PATH the list of things to try includes `turno auto mcp list` in `~/code/acme`,
  which connects to both servers through mcpd without signing in.
- Tests: `init.test.ts` (dry run, refusal without `--yes`, one journal and one undo, prompts,
  flags, rule inference, masked secrets, migrate pending) and `demo.test.ts` (in-process demo
  with a real MCP initialize through the gateway, env allow list, `--` exit code and cleanup, the
  wait mode stopped like Ctrl-C, stale folders; and, when `dist` is built, SIGINT on the real CLI
  and a copy laid out like npx's cache). Both run in a sandbox HOME, and the global guard checks
  the run's HOME stays empty.

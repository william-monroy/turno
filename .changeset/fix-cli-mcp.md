---
"turno-cli": minor
---

`turno mcp` commands are safer and clearer:

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

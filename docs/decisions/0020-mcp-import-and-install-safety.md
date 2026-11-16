# 0020. `turno mcp import` previews without effects, and `turno mcp install` pins exact versions

Date: 2026-11-16. Status: accepted.

## Context

The audit of 2026-11 found that `turno mcp import`, the first command the README suggests,
printed every literal secret in its preview and stored secrets in the Keychain with
`--move-secrets` even without `--write`. It only read user servers in `~/.claude.json`, so a
Codex or Cursor user got `cannot read ~/.claude.json`, and it copied `${VAR}` references
literally, which neither mcpd nor the Keychain expands. `turno mcp install` ran
`npm install <spec>` with install scripts and no lockfile, so the importer's promise that
install "pins" a package was false. Every `mcp` subcommand parsed flags by hand, so `--help` and
mistyped flags ran writes.

## Decision

- Every `turno mcp` subcommand goes through `group()` and `parseFlags` (strict): `--help` prints
  usage, an unknown flag is a usage error (exit 2). Read commands take `--json`, write commands
  take `--dry-run`. `mcp import` keeps its preview default; `--dry-run` is accepted as a synonym.
- The importer is pure: it returns the manifest, a preview with literal secrets masked
  (`ghp_****1234  # secret, hidden`) and the list of secrets to move. Only `--write
  --move-secrets` stores them, after every check passed, and never a value containing `${`.
- Secrets are detected by key words (`token`, `key`, `secret`, `password`, `auth`, ...) split on
  `_`, `-` and camelCase (so `PATH` and `PWD` do not match), by known token prefixes (`ghp_`,
  `sk-`, ...), in args (`--api-key=x`, `--token x`) and in URL query strings. Args and URLs
  cannot reference the Keychain, so those stay literal, masked in the preview, with a note.
- `${VAR}` and `${VAR:-default}` (and Cursor's `${env:VAR}`) become `env:VAR` and
  `env:VAR:-default`. The resolver in `core/secrets.ts` learned the `:-default` form (shell
  semantics: the default applies when the variable is unset or empty). A value that mixes text
  and a variable is kept as written with a note. For remote headers, a variable is kept as
  written while the server stays direct, because Claude Code expands it itself; a proxied
  server would not, so whole variables become `env:` there.
- Sources: user and project servers in `~/.claude.json`, `.mcp.json` of the current folder,
  `~/.codex/config.toml` (`[mcp_servers]`, with `env_vars`, `bearer_token_env_var` and
  `env_http_headers` turned into `${VAR}` references), `~/.cursor/mcp.json` and
  `~/.copilot/mcp-config.json`. Entries turno wrote (gateway entries) are skipped. The first
  source wins a name; a differing duplicate is noted. Zero servers writes nothing.
- `turno mcp install` resolves the spec to an exact version with `npm view`, installs with
  `--ignore-scripts` (opt in with `--allow-scripts`), `--save-exact` and a package lock in
  `servers/<name>/`, reinstalls with `npm ci` when the lock matches, and rewrites `package` in
  `mcp.toml` to `name@x.y.z` (a line edit that keeps comments, journaled for `turno undo`).
- `turno mcp refresh` asks a running mcpd with `POST /refresh/<server>` and falls back to the
  restart hint when the endpoint answers 404 (an older daemon).
- `turno mcp sync` reads live sessions only from the paths of its own environment, treats a
  plain `claude` session as busy for `~/.claude.json`, plans before writing (no backup and no
  undo hint when nothing changes), never creates the token in a dry run, and warns when mcpd
  does not answer.

## Consequences

- Previews can be recorded or shared. Piping the preview to a file gives masked values, which is
  intended: `--write` is the way to write.
- A server that needs its install scripts must be installed with `--allow-scripts`; the failure
  message says so.
- `env:` references read mcpd's environment. Under the LaunchAgent that is almost empty, so the
  import notes recommend `launchctl setenv` or `keychain:` references.
- Still open: the `npx -y` fallback in `mcpd/instances.ts` for packages not yet installed, and
  `${VAR}` expansion inside stdio env values and args by mcpd.

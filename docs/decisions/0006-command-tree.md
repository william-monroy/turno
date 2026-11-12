# 0006. One command tree, old names as aliases

Date: 2026-11-12. Status: accepted.

## Context

turno 0.1 grew one command at a time. Account commands were loose verbs at the top level
(`which`, `usage`, `exhausted`, `available`, `sessions`, `handoff`, `setup`) while newer areas
used a noun and a verb (`mcp sync`, `browser add`). "Account" meant three things: a Claude Code
profile, a service account of the bridge (`accounts`), and a browser identity. Flags differed per
command (`--watch` and `--vigilar`, `-n` and `--tail`, a positional `until`), `--json` existed in
six commands and `--dry-run` in three. Several commands printed partial health (`status`,
`doctor`, `mcp doctor`, `ui status`). Profiles and project rules were edited by hand.

## Decision

- Noun, then verb: `profile`, `limit`, `session`, `identity`, `mcp` (with `mcp daemon`),
  `secret`, `ui`, `config`. `run <profile|auto>` is the long form of `turno <profile>`.
- `identity` covers everything that acts on an outside service: service accounts
  (`linear:work`) and browser identities (`browser:school`). `browser` keeps the engine bench.
- Every 0.1 name and every Spanish word of the bash script stays as an alias in
  `cli/registry.ts`, hidden from the help, so hooks, launchers, Orca, skills and habits keep
  working. Profile names cannot take any command or alias name.
- Shared flags come from `cli/args.ts` (node `util.parseArgs`): `--json` on every read
  command, `--dry-run` on every write command, `--watch`, `-n/--tail`, `--until`, `--force`.
- `status` is a one-screen summary; `doctor` holds every check, each with an optional fix,
  and `doctor --fix` runs the fixes of failed checks and checks again.
- Groups and commands declare their subcommands, argument kinds and flags, which feed the
  help and `turno __complete`, the engine behind `turno completion zsh|bash|fish`.

## Consequences

- One place (`registry.ts`) lists commands, sections and aliases.
- `accounts.toml` is still regenerated on write (it is a managed file); config.toml edits go
  through `core/toml-edit.ts` and keep comments.
- Adding a command means adding it to the registry and, for completion, declaring `args` and
  `flags`.

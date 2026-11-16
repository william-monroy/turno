# 0021. turno auto never falls back to another account in silence

Date: 2026-11-16. Status: accepted.

## Context

`turno auto` is the promise of the product: a work repository opens with the work account.
Until 0.1.1 it ran the plain agent (the account of `~/.claude`) whenever it could not run the
folder's profile: a deleted launcher, a `default` naming a profile that does not exist, or a
`config.toml` that does not parse. Only the broken config printed a line, and the agent's
interface covered it at once. A first-run review reproduced all three; a comment on the launch
thread made the related point that any default account is risky, because a subprocess that
loses `CLAUDE_CONFIG_DIR` lands on it.

## Decision

- When the rules choose a profile and it cannot run, `turno auto` exits 1 and names the fix:
  `turno profile repair <p>` for a missing launcher, `turno profile add <p>` or the rule for a
  missing profile.
- A `config.toml` that does not parse is an error too (exit 1, with the TOML message). The
  escape hatch is `TURNO_ALLOW_PLAIN=1`, which runs the plain agent and says so on stderr.
- `system = ""` means "no default account": in a folder without a rule and without a `default`,
  `turno auto` exits 1 instead of running the plain agent.
- Without a rule and without a default (and `system` unset), `turno auto` still runs the plain
  agent, as before, and says so on stderr in a terminal. For an agent with no profile at all
  (`turno auto --agent codex` before any Codex profile) it says so always.
- `config set` checks that `system`, `default`, `fallback` and `agents.<agent>.*` name existing
  profiles of the right agent, and `doctor` warns about rules and roles that point at missing
  profiles, so the error above is rare.

## Consequences

- A broken `config.toml` now stops `turno auto` (and `turno-auto` in editors) until it is fixed.
  That is the point, and `turno doctor` and `turno config check` show the line to fix.
- `docs/accounts.md` explains where the account follows the environment and where it does not.
- turno still does not wrap the plain `claude` command: processes started outside turno use
  `~/.claude`. Signing that folder out is the way to make them fail instead.

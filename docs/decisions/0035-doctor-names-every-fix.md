# 0035. turno doctor names the fix for every finding

Date: 2026-11-17. Status: accepted.

## Context

`turno doctor` printed one line per check (`warn  text  [fix: ...]`), but only the repairs that
`--fix` can run had a fix label. The other findings hid their advice inside the text, often in
parentheses at the end, and some had none: a person had to guess, and a program reading `--json`
could not tell a command from a sentence. Doctors of other CLIs (Vercel, mise, Codex) give each
finding a status, the exact command that fixes it, and a one-line summary for hooks.

## Decision

**Three ways to fix, kept out of the text.** A check (`Check` in `cli/commands/doctor.ts`, and the
same fields in `mcpd/health.ts` and `cli/security.ts`) carries at most one of:

- `fix`: a repair `turno doctor --fix` runs; its label is the command a person would type.
- `hint`: a command that fixes it, which a person runs (installing an agent, `turno mcp login`,
  `turno mcp token rotate`).
- `manual`: the manual step, when no single command fixes it (move a launcher turno did not
  write aside, add a folder to PATH, store a secret and write its reference).

Every warning and failure has one of them; a test walks a sandbox with many problems and checks
it, and that the text no longer ends in a parenthesized command. A skipped check may carry an
optional one (`turno ui install`).

**Status.** `ok`, `warn`, `fail` and `skip`; a check of level `info` is a skip. The exit code does
not change: 1 when a check fails, 0 with warnings only.

**The screen.** Sections (System, Config, Profiles, MCP, Look, Gateway, and Security for
`--security`) drawn with `cli/style.ts`; one row per check with its icon; under each problem
`fix: <command>` (with "turno doctor --fix runs it" when it does), `manual: <step>`, or
`optional: <command>` under a skip. Rows in a run with the same fix (one profile's links) share
one fix line. Profile rows show the profile as its pill. The last lines are the counts with the
time (`12 ok, 2 warnings, 1 failure, 3 skipped in 340ms`) and, when `--fix` can repair something,
`Next  turno doctor --fix`. Plain text keeps the layout with ASCII icons and the profile name on
every row, so it stays greppable.

**`--json`.** Each check keeps `area`, `level`, `text` and `fix` (now the command, whether `--fix`
runs it or not, or null) and adds `status`, `auto` (whether `--fix` runs it) and `manual`. The top
keeps `ok` and adds `counts` (`ok`, `warn`, `fail`, `skip`), `ms` and `next`: the fix commands of
failures, then of warnings, each once.

**`--summary`.** One line, `turno doctor: 12 ok, 2 warnings; fix: turno profile repair work`, for
hooks and status lines, with the same exit code. It does not combine with `--json`.

## Consequences

- A new check must say how to fix it; the test fails otherwise.
- The plain output changed shape (`warn  text  [fix: ...]` became a row and a `fix:` line);
  scripts should read `--json`, whose existing fields kept their meaning.
- `config check` and `turno status` keep their own wording; their texts were not moved.

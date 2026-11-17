# 0037. One color switch: --color, TURNO_COLOR and their order

Date: 2026-11-17. Status: accepted.

## Context

turno colored its output on a terminal, honored `NO_COLOR`, and since the highlighting work
`FORCE_COLOR` too. There was no way to ask for colors in a pipe (`turno mcp log | less -R`) or to
turn them off for one run without an environment variable, and nothing that stated which of the
variables wins when several are set.

## Decision

A global `--color auto|always|never` flag, and `TURNO_COLOR` with the same values. `main` takes
the flag the way it takes `--no-input` (ADR 0033): before the command (`--color always` or
`--color=always`), or among a command's own flags, never after `--` and never from the arguments
of `run`, `auto`, `hook`, `statusline` or a profile. Among a command's flags only the three modes
count, so `turno profile add work --color green` keeps its own `--color`. The last one given wins;
a bad value before the command is a usage error (exit 2).

The flag lives on the run's `Io` (`io.color`), not in the environment: agents that turno starts
must not inherit colors forced for one command.

`colors(io)` decides, and the first rule that applies wins:

1. `--color always|never`;
2. `TURNO_COLOR=always|never` (any other value counts as auto; `--color auto` sets it aside);
3. `NO_COLOR` set and not empty: off;
4. `FORCE_COLOR`: `0` or `false` off, anything else on, also in a pipe;
5. auto: on when standard output is a terminal.

The flag and `TURNO_COLOR` come before `NO_COLOR` because no-color.org lets a per-run argument or
a tool's own setting override it; `NO_COLOR` comes before `FORCE_COLOR` as in uv.

`--json` output is the exception: it is colored only when it goes to a terminal, whatever the
flag says, because programs read it (`printJson`).

The status line keeps its own rule (docs/ui.md): it always draws its colors, because Claude Code
shows them inside its interface.

## Consequences

- `turno --color always mcp log | less -R` and `turno status --color never` work without
  touching the environment.
- Tests cover the order (`test/style-rollout.test.ts`).

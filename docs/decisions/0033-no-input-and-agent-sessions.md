# 0033. No questions without a person: --no-input and agent sessions

Date: 2026-11-17. Status: accepted.

## Context

A few commands ask before they change files (`turno init`, `turno profile add` and `repair`
when they move a person's own files aside, `turno uninstall`, `turno browser bench`, the hidden
prompt of `turno secret set`, the `turno mcp sync` question of `turno upgrade --finish`). They
already skipped the question when stdin was not a terminal, but each one failed in its own words
and most with exit 1. Coding agents run turno too, and some give their commands a pseudo
terminal: a question there waits for an answer that never comes.

## Decision

**When turno asks.** Only when stdin and stderr are terminals and none of these hold: the global
`--no-input` flag, `TURNO_NO_INPUT` set to anything but `0` or `false`, or a variable that a
coding agent sets for the commands it runs. `main` takes `--no-input` before the command or among
a command's own flags (never after `--`, and never from the arguments of `run`, `auto`, `hook`,
`statusline` or a profile, which belong to the agent) and turns it into `TURNO_NO_INPUT=1` in the
environment of the run, so a turno that this one starts (`upgrade` running `upgrade --finish`)
does not ask either. `TURNO_NO_INPUT=0` wins over an agent variable, because editor extensions
set some of them in the terminals a person types in.

**Agent variables**, checked against each agent's documentation or code:

| Agent | Variable | Source |
|---|---|---|
| Claude Code | `CLAUDECODE=1` | env-vars reference: set in subprocesses Claude Code spawns (Bash and PowerShell tools, tmux sessions, hooks, status line, stdio MCP servers); IDE extensions also set it in their terminals. https://code.claude.com/docs/en/env-vars |
| Claude Code | `CLAUDE_CODE_CHILD_SESSION=1` | same page: set only by Claude Code for Bash, PowerShell and Monitor tools, hooks and status line (v2.1.172 or later) |
| Codex | `CODEX_THREAD_ID` | openai/codex `codex-rs/core/src/exec_env.rs` (injected in the shell environment when a thread id is known) and `codex-rs/protocol/src/shell_environment.rs` |
| Codex | `CODEX_SANDBOX` | openai/codex `codex-rs/core/src/spawn.rs` (set when the command runs under the sandbox, `seatbelt` on macOS) |
| Copilot CLI | `COPILOT_CLI=1` | github/copilot-cli `changelog.md`, 0.0.421: "Git hooks can detect Copilot CLI subprocesses via the COPILOT_CLI=1 environment variable to skip interactive prompts" |
| Copilot CLI | `COPILOT_AGENT_SESSION_ID` | same changelog, 1.0.29: "Shell commands and MCP servers now receive COPILOT_AGENT_SESSION_ID" |
| Cursor | `CURSOR_AGENT=1` | Cursor CLI 2026.10.01 bundle: the shell tool spawns commands with `CURSOR_AGENT: "1"` in their environment; also discussed on forum.cursor.com |

The list lives in `cli/io.ts` (`AGENT_SESSION_ENV`, by agent id), not in the adapters: every run
loads `io.ts`, which stays free of heavy imports. A test keeps its ids equal to `AGENT_IDS`.

**One way to fail.** A question nobody can answer is a usage error: exit 2 and
`turno: <command> needs an answer; pass <flag> (or run it in a terminal)`, where the flag is
`--yes` or, for `secret set`, "the value on stdin". Context the person needs to decide (the plan
of `init`, the files `profile add` would move aside) still goes before it. `upgrade --finish`
does not fail: the upgrade is done, so it names `turno mcp sync` instead of asking.

## Consequences

- Scripts and agents get the same exit code and wording from every command, and the flag to
  retry with.
- A person in an editor terminal that sets `CLAUDECODE` is not asked either; `--yes` or
  `TURNO_NO_INPUT=0` gets past it.
- `turno demo` without a command still waits for Ctrl-C when there is no terminal: it asks no
  question, and its long run is the point.
- A new agent adds its session variables to `AGENT_SESSION_ENV` with a source here.

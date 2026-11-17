# 0036. A profile picker when the argument is missing

Date: 2026-11-17. Status: accepted.

## Context

Several commands need a profile: `turno profile assign`, `turno profile remove`, `turno run`,
`turno session handoff`, `turno limit set` and `clear`, and `turno open` for a claude.ai link.
Without one they printed a usage line, so a person had to run `turno profile list`, read the
names and type the command again. Tools like `gh auth switch`, `mise use` and `vercel switch`
open a list instead. turno also runs inside agents and scripts, where nobody can answer
(ADR 0033).

## Decision

**A picker in `cli/picker.ts`, with no dependencies.** It lists the profiles as their pills with
the agent and the account (email, "not logged in", or the launcher for agents without account
details), marks the profile the folder resolves to (and puts the cursor on it), and marks
exhausted ones. Arrow keys, Ctrl-N/Ctrl-P, Page Up/Down, Home/End and j/k move; j and k move only
while the filter is empty, because any letter typed starts the filter (name matches first, then
agent and account). Enter chooses, Esc, Ctrl-C or Ctrl-D cancel with exit 130 and nothing
changed. The accounts come from `claude auth status`, so the list draws at once with `...` and
fills in when the answers arrive.

**Only where a person can answer.** The picker runs when `io.ask` is set (ADR 0033), with raw
mode on stdin only when stdin and stderr are terminals; it draws on stderr, so stdout stays for
the command's output. With an `ask` but no raw terminal it asks for a number or a name. Without
`ask` the command fails through `needsAnswer` with exit 2 and the valid values
(`profile assign needs an answer; pass a profile: personal, work`). `turno session handoff` keeps
printing its `profiles:` and `current:` lines there, for scripts that read them. `turno open`
asks only for a claude.ai link outside a profile's session (no `CLAUDE_CONFIG_DIR` of a profile);
anywhere else it keeps its default (the session's profile, then the system profile), so Claude
Code calling it through `$BROWSER` never sees a question.

**The terminal is always restored.** Keys go through a pure state machine (`parseKeys`,
`reduce`) that tests drive without a terminal. The real terminal turns raw mode on and returns
one function that turns it off, removes the listeners and shows the cursor; it runs on a choice,
a cancel, an error while drawing, and on SIGINT, SIGTERM or SIGHUP (then the signal is raised
again) or process exit.

**A picked profile removal is confirmed.** `turno profile remove` without a name asks a y/N
question after the choice; with a name it behaves as before.

## Consequences

- `turno profile assign [dir] [profile]`: both are optional now; the folder defaults to the
  current one. A single argument that is a profile name and not a folder gets a hint
  (`turno profile assign . work`).
- `turno run` with no profile no longer prints a usage line on a terminal.
- The module loads lazily, only when a profile is missing, so hot paths keep their speed
  (ADR 0034).

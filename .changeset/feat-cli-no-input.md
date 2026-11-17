---
"turno-cli": minor
---

turno never waits for an answer nobody can give.

- A global `--no-input` flag (before or after the command) and `TURNO_NO_INPUT=1` turn every question off. turno also asks nothing inside a coding agent's session: Claude Code (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`), Codex (`CODEX_THREAD_ID`, `CODEX_SANDBOX`), Copilot CLI (`COPILOT_CLI`, `COPILOT_AGENT_SESSION_ID`) and Cursor (`CURSOR_AGENT`). `TURNO_NO_INPUT=0` allows questions again, for an editor terminal that sets one of those variables. Without a terminal there were no questions already.
- A command that needs an answer then exits with code 2 (`init`, `uninstall` and `profile add` used 1) and names the flag that gives it, in one format: `turno: init needs an answer; pass --yes (or run it in a terminal)`. This covers `turno init`, `turno profile add` and `turno profile repair` (moving your own files aside), `turno uninstall`, `turno browser bench`, and `turno secret set`, which no longer shows its hidden prompt and asks for the value on stdin instead. `turno upgrade --finish` does not ask about `turno mcp sync` and names it instead.
- `turno help` mentions `--no-input`.

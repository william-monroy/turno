---
"turno-cli": minor
---

Bare `turno` now shows the status screen once turno is set up (the help before that), and `turno status` ends with the one thing to do next (`turno init`, `turno profile repair <p>`, `turno mcp daemon start`, `turno mcp sync`, `turno upgrade` or `turno ui install`); `status --json` has it as `next`. `turno init` also offers to start the gateway and point every profile at it in the same run and the same journal (asked in a terminal; `--start` with `--yes`, `--no-start` to skip), and ends with the command to try.

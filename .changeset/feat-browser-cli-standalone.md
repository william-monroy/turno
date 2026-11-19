---
"turno-browser": minor
"turno-cli": minor
"turno-core": minor
---

turno-browser has its own `turno-browser` command: add, list, show, set, login, vault, export, import, flows, replay, record, traces, live, pause, resume, doctor and reputation work without turno, with `--version` and a help grouped by section. `turno-browser add` prints how to connect an agent instead of an `mcp.toml` block, and `turno-browser do` says it needs turno for now. `turno browser ...` and the browser part of `turno identity ...` now run turno-browser's commands through its typed api (API_VERSION 1.12, new member `cli`) with the same flags, output and exit codes, so turno-cli needs turno-browser 1.12 or a later 1.x. turno-core gains `turno-core/cli`, the command line toolkit (arguments, output, styles, exit codes, command groups, hints, hidden input) that both programs share.

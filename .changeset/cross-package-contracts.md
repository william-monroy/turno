---
"turno-browser": minor
"turno-cli": minor
---

Cross-package contracts:

- turno-browser exports its public API as a typed `api` object with `API_VERSION` (1.0).
  turno-cli checks it when it loads the package: a turno-browser that is too old (0.2 and older
  have no `API_VERSION`) or too new stops `turno browser` and `turno identity browser:<id>`
  with one line naming what to update, instead of failing later.
- mcpd sends every `tools/call`, from 2025-11-25 sessions and 2026-07-28 requests alike,
  through one call middleware: the profile's tool filter, then the call log, then the session id.
  Refusals and call log records are unchanged.
- Each relayed `tools/call` carries `_meta["io.turno/session"]`, an opaque id that is stable for
  one agent session and different for every other. turno-browser-mcp hands it to its own tools
  (`session` in their context); the Playwright tools are unaffected.

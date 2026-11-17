---
"turno-cli": minor
---

mcpd follow-ups:

- `turno mcp logout` tells a running mcpd, which stops using the old access token at once
  (it used to keep it for up to a minute). New admin endpoint: `POST /logout/<server>`.
- When mcpd stops, it tries once more to save rotated OAuth tokens the secret store refused
  earlier, and logs the servers whose tokens are still lost.
- `/status` reports the memory pressure (`memoryPressure`: level, idle cap, setting), and
  `turno mcp top` shows it in its header (and as `memoryPressure` in `--json`). A change to
  `mcpd.idle_under_pressure` in config.toml now applies without a restart.
- Open sessions get `tools/list_changed` (and prompts and resources when the server is hidden
  or shown) when an `mcp.toml` tool filter or a folder's server set in config.toml changes
  what they see.
- A call cancelled while its server is still starting is dropped instead of sent once the
  server is up.

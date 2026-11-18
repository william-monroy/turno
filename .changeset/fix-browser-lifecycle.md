---
"turno-browser": minor
"turno-cli": minor
---

Browser lifecycle:

- `turno-browser-mcp` passes a generated Playwright MCP `--config` that closes Chrome after 15
  minutes without a tool call, headed too; the next call opens it again with the same profile.
  `TURNO_BROWSER_IDLE` changes the limit (`"10m"`, `"0"` keeps Chrome open); `--idle-timeout`
  and a `--config` of your own still win. Flags and tool names are unchanged.
- On start it closes a Chrome that an earlier, killed run left open on the same profile (only
  a Chrome browser process for exactly that profile whose parent is gone), and on stdin close,
  SIGTERM or SIGHUP it closes Chrome within about 2.5 seconds, forcefully if needed.
- mcpd stops a quiet `session` server under critical memory pressure even while its session
  lives; the next call starts it again. `turno mcp top` counts the process groups a server's
  children lead, so a browser's helpers always count.
- Docs: one recommendation for browsers, a `shared` server with `exclusive = true` per identity
  (the block `turno identity add` prints), instead of `scope = "session"`.

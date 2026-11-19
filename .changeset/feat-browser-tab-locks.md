---
"turno-browser": minor
"turno-cli": minor
---

Several agent sessions can now share one browser identity, each in its own tabs. Turn it on per identity with `"sharing": "tabs"` in identity.json (`turno identity set browser:<id> --sharing tabs`, or the server's `--sharing tabs`) and serve the identity with `exclusive = false` in mcp.toml; the default stays one session at a time. Each session gets its own current tab and holds the tabs it works on: another session's call on one of them waits up to 10 seconds and then fails with a message that names the holder. A session lets go of its tabs when it ends (mcpd now tells servers that declare the `io.turno/sessions` capability), when a tab closes, or after 5 minutes without a call. `browser_close` closes only the calling session's tabs, tab lists mark the tabs other sessions hold, and the tab governor's cap counts each session's tabs apart. `turno identity add browser:<id> --sharing tabs` prints the matching mcp.toml block. turno-browser's API version is now 1.4.

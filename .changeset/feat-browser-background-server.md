---
"turno-browser": minor
"turno-cli": patch
---

`turno-browser-mcp --identity <id> --background` serves an identity to the shell without turno: MCP over streamable HTTP on a Unix socket in a private folder of the identity's state (or 127.0.0.1 with a per-server token where a socket cannot be used), one Chrome shared by every connection with the identity's sharing rules, and an exit after 15 minutes without a request (`--background-idle`, `TURNO_BROWSER_BACKGROUND_IDLE`). While it runs it alone drives the identity's browser: a stdio server of the same identity refuses calls that need the browser with a message that names it, and it does not start while another process has the identity's Chrome open. The package exports a client for it (`startBackground`, `backgroundStatus`, `openBackgroundSession`, `stopBackground`), also in the typed api, now version 1.11. turno-cli now asks for turno-browser 1.11 or a later 1.x.

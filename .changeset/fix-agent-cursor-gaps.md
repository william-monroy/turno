---
"turno-browser": patch
"turno-cli": patch
---

The agent cursor follows the pointer path with humanize on, counts the other busy sessions on the badge with shared tabs, keeps the typing bubble up long enough to see, and keeps its label inside the page. Each session's cursor is named after its own agent ("Claude Code", "Codex", "Cursor", "Copilot", "Gemini CLI") instead of the raw client name or the name of the first one: mcpd sends the client's name with each call (`io.turno/client` in `_meta`), and a shared host uses each connection's own.

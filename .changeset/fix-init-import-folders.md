---
"turno-cli": patch
---

`turno init` and `turno mcp import` now find MCP servers configured inside profile folders (`~/.claude-<name>`, `~/.codex-<name>`, ...), not only in each agent's main config. Previews (`turno init --dry-run`, `turno mcp import` without `--write`) no longer ask npm for command names; that lookup happens only when the manifest is written.

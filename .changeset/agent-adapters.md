---
"turno": minor
---

Profiles for Codex CLI, GitHub Copilot CLI and Cursor CLI: `turno profile add <name> --agent codex|copilot|cursor` creates the profile folder (one login per account) and its launcher, `turno mcp sync` points it at the MCP gateway without writing the token into the agent's config, folder rules work per agent (`turno auto --agent codex`, `[agents.codex]` default and fallback), and `turno mcp config --agent <name>` prints gateway entries for opencode, Gemini CLI, Goose, Crush, Droid and Kiro.

---
"turno-cli": minor
---

mcpd speaks MCP 2026-07-28 next to 2025-11-25, and stops idle servers sooner when memory is low:

- Agents that use the stateless 2026-07-28 revision (no `initialize`, no session id,
  `Mcp-Method` and `Mcp-Name` headers) are served directly instead of falling back to a
  2025-11-25 session: `server/discover`, cached `tools/list`, `prompts/list` and
  `resources/templates/list` with `ttlMs` and `cacheScope`, relayed calls with progress and
  cancellation, and `subscriptions/listen` for list changes and resource updates. Headers that
  disagree with the body are refused as the revision requires. 2025-11-25 sessions work as
  before. Elicitation and sampling still need a 2025-11-25 session.
- When the machine is short of memory (macOS memory pressure, Linux PSI, else free memory), idle
  MCP servers stop after `idle_under_pressure` (default 5 minutes, a quarter of it when pressure
  is critical) instead of their usual 20 or 30 minutes. Set it under `[mcpd]` in config.toml or
  with `turno config set mcpd.idle_under_pressure 10m`; `false` turns it off. Session servers
  whose agent still runs are kept.

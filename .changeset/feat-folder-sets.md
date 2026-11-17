---
"turno-cli": minor
---

Pick which MCP servers each folder sees, and a round of follow-ups:

- A `[[projects]]` rule in config.toml can carry `mcp = ["issues", "docs"]` (only these
  servers) and `mcp_deny = ["mail"]` (not these), with or without a `profile`. mcpd hides the
  other servers from sessions in that folder: they show no tools, refuse calls and never start.
  A git worktree follows its main repository's rule. mcpd now reloads config.toml when it
  changes or on SIGHUP. `turno config check` warns about server names that are not in mcp.toml
  and about direct remote servers a set cannot hide, `turno profile which` shows a folder's set,
  and `profile assign`, `unassign` and `remove` keep it.

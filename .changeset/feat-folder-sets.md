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
- `turno upgrade --finish` offers to run `turno mcp sync` when agent configs need a new gateway
  token (it asks in a terminal; `--yes` runs it), and records the launchers it rewrites so
  `turno undo` can put them back.
- `turno mcp sync` removes the token files it wrote for profiles that no longer exist.
- `turno mcp list` shows each server's tool filters (allow and deny), also per variant.
- Changing a server's tool filter no longer restarts its process.
- `turno doctor` warns about accounts in accounts.toml without `read_tools`, and
  `turno doctor --security` counts the profile tokens next to the token age and warns about
  token files older than the current gateway token.
- `turno mcp install` keeps `servers/<name>/` private (mode 700).
- mcpd applies `call_log` changes without a restart, and sessions it rebuilds after a restart
  keep their agent's name in the call log.
- `turno undo` of `profile add` puts back the previous mode of a profile folder that existed.

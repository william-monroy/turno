---
"turno-cli": minor
---

Diagnostics and safe mode:

- `turno mcp call <server> [tool] [--args JSON] [--arg k=v|k:=json] [--profile p] [--json]`
  calls a tool through mcpd as a profile's session in this folder would, or lists the tools.
  Exits 1 on `isError` or a refused call, 5 when mcpd is down.
- `turno doctor --report` prints a Markdown block for an issue: turno, Node, OS, each agent's
  version, mcpd, the findings and every path, with no tokens or secret values.
  `turno config path --all` lists every path turno uses.
- Safe mode: `turno run <p> --no-gateway`, `turno <p> --no-gateway`, `turno auto --no-gateway`,
  or `TURNO_SAFE=1`, opens the agent with the profile's account but without the gateway entries,
  the gateway token and (Claude Code) the status line and hooks.
- Copilot CLI and Cursor CLI gateway entries send the session folder (`X-Turno-Cwd-B64`), so
  folder server sets apply to them without the process lookup. Run `turno mcp sync` to rewrite
  existing entries.
- `system = ""` no longer becomes an empty profile name for the hub's gateway token; `turno
  status` and `turno profile which` say "no profile" for folders without a rule.

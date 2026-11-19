---
"turno-cli": minor
---

`turno browser do <id> <action>` drives a browser identity from the shell, for coding agents that
prefer commands to MCP tools: `open`, `back`, `snapshot`, `read`, `find`, `click`, `type`,
`press`, `select`, `hover`, `wait`, `screenshot`, `tabs`, `login` (a vault sign-in), `call` (any
tool of the server), `close`, `session` and `end`. Each action is one tool call through mcpd to the
identity's turno-browser-mcp, so the tab locks or the one-session lease, attach mode, read mode's
refusals, humanize, recordings and the vault apply as they do to an agent. The commands one agent
or one terminal shell runs are one session and keep their tab: turno keeps the mcpd session open
between them and ties it to the agent (or the shell), and `end` closes it; `--session <name>` or
`TURNO_BROWSER_SESSION` keeps several apart. Output is `url:` and `title:` lines and what the
action returned, errors on stderr with exit 1, or one object with `--json`. `turno browser <id>
<action>` is the short form when the id is not a subcommand. The Claude Code plugin adds a short
`browser-identity` skill that teaches the loop and reads the installed help first.

---
"turno-cli": minor
---

See what the gateway does and what it saves:

- `turno mcp log [-f] [-n N] [--server S] [--profile P] [--json]` shows the tool calls mcpd
  relayed: time, outcome (ok, error, cancelled, timeout), duration, server and variant, tool,
  profile, agent and request and response sizes. mcpd keeps them in
  `~/.local/state/turno/logs/calls.jsonl` (mode 600, rotated at 5 MiB). Records never hold the
  call's arguments or result, and error texts have tokens redacted. Turn it off with
  `call_log = false` under `[mcpd]` in config.toml.
- `turno mcp top [--once] [--json]` shows each running server's memory (with its child
  processes), sessions, calls in flight, idle time and restarts, refreshing every 2 seconds in a
  terminal.
- `turno mcp savings [--json]` compares the memory of mcpd and its servers with an estimate of the
  same agent sessions without the gateway (sessions x per-server memory).
- The mcpd `/status` endpoint now lists the agent sessions and each instance's restarts.

---
"turno-cli": minor
---

The MCP gateway daemon is sturdier and runs on Linux.

- `turno mcp daemon start|stop|restart|status` use a `systemd --user` unit on Linux and the LaunchAgent on macOS; without either you get one clear line instead of a stack trace, and `~/Library` is never created on Linux.
- mcpd runs as a single instance and never moves to another port: if `mcpd.port` is busy it fails and names the process that holds it, in `mcp daemon status` and `doctor` too. `mcpd.port` is removed when mcpd stops.
- A broken `mcp.toml` no longer keeps mcpd from starting: it serves the last valid copy (or no servers) and shows the error in `mcp daemon status` and `doctor`. A broken `config.toml` falls back to defaults.
- `mcpd.log` rotates at 5 MiB, and socket or disk errors are logged instead of stopping the daemon.
- The LaunchAgent runs as `Interactive`, prefers a stable `turno` or node path over a version manager's, restarts only after a failure, and is written through the journal (`turno undo` restores it). `mcp daemon start --dry-run` prints it; `mcp daemon stop` also removes it, so mcpd does not come back at login; `turno upgrade --finish` rewrites it and restarts mcpd.
- `turno doctor` checks that the port is held by your own mcpd, that the service file points at paths that exist, that synced profiles use mcpd's port, and that the token file is mode 600.
- New `turno mcp token rotate`. The token file's mode is checked and fixed on every read.
- `turno mcp daemon logs` shows local time (`--utc` for the raw lines).
- `turno mcp daemon` rejects unknown flags and `--help` never runs an action.
- `turno upgrade` accepts only a plain version from the registry or `--to`.
- On Linux the client of a gateway connection is found from `/proc` when `lsof` is missing.

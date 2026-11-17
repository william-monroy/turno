---
"turno-cli": patch
---

Faster help and startup, with the same output.

- `turno --help` renders from a static table of command summaries and no longer loads every command module (about 3x faster).
- `turno`, `turno status` and `turno mcp ...` no longer load the MCP SDK just to read the gateway's token, port and lock files, or to list OAuth logins.
- `claude auth status` answers are kept for five minutes in turno's state folder, keyed by the profile's login files (`.claude.json`, `.credentials.json`), so `turno`, `turno status` and `turno profile list` no longer start one `claude` per profile on every run. Logging in or out asks again; failures are never kept.
- `turno profile which` and `turno status` ask git for the folder's repository once instead of once per agent.
- The CLI turns on Node's compile cache in `~/.cache/turno` (or `$XDG_CACHE_HOME/turno`); `NODE_COMPILE_CACHE` and `NODE_DISABLE_COMPILE_CACHE` work as for any Node program. `turno demo` runs without it, and `turno uninstall` lists the folder as one that stays.

---
"turno-cli": minor
---

The new look reaches more screens, and colors get one switch.

- `turno limit show` draws each profile as its colored pill with the account, a usage bar per window colored by level, the reset time, `used up` when a window is full and a red mark while a profile is marked exhausted.
- `turno mcp list` is a table with server, kind, scope, idle time, profiles (as pills), state (running or stopped in mcpd, or direct), auth (oauth login state, or `secret` when it uses a keychain or env reference) and the details (command or URL, variants, package, tool filters, logins). On a terminal the column titles are muted lowercase, paths are shortened to `~`, the details wrap under their own column and a narrow terminal drops the secondary columns first; nothing runs past the terminal width. It says once when mcpd is not running.
- `turno mcp top` and `turno mcp log` line up their columns, right-align numbers, show running icons and color the outcome of each call (ok, error, timeout, cancelled), calls in flight, restarts and errors. On a terminal `mcp log` shows only the time when every call is from today, fits each line to the width (long names end in `…`, the agent and then the sizes go first on a narrow terminal) and puts an error on its own line; piped output keeps its columns.
- On a terminal, a word longer than the line (a long path) is cut at the width instead of running past it.
- `turno identity list` has sections (service accounts, folder preferences, browser identities) with aligned rows, profile pills and the confirm policy under each account.
- A global `--color auto|always|never` and `TURNO_COLOR`. Order: `--color`, then `TURNO_COLOR`, then `NO_COLOR`, then `FORCE_COLOR`, then whether output is a terminal. `--json` stays plain outside a terminal whatever the flag says.
- The status line pill and every other profile pill use one color rule.
- `turno demo` without a terminal (a pipe, `--no-input`, an agent) prints what it set up and ends instead of waiting for Ctrl-C forever; `--keep` keeps it running until Ctrl-C (also in a terminal, instead of opening a shell).

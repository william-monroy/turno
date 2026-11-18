---
"turno-cli": minor
---

An output contract for scripts, hooks and agents (ADR 0045):

- Every `--json` object carries `schemaVersion` (each element, for a list); no existing key
  changed. `--json=fields` lists a command's fields, `--json=a,b` keeps only those, and an
  unknown field is exit 2 with the list. Under `--json`, errors are one JSON line on stderr:
  `{"schemaVersion":1,"error":{"code":"usage","exitCode":2,"message":"..."}}`.
- `turno limit show --watch --json` and the new `turno mcp top --watch --json` print NDJSON, one
  record per line, like `turno mcp log --follow --json`.
- Exit codes: 0 ok, 1 failure, 2 usage, 3 no profile for the folder, 4 not signed in, 5 mcpd
  down (`turno help exit-codes`). Changed: `turno auto` exits 3 (was 1) when the folder's
  profile does not exist or there is no rule with `system = ""`; `turno mcp daemon status`,
  `turno mcp top` and `turno mcp savings` exit 5 (was 1) when mcpd is down.
- `turno profile which --check` answers with that code and prints nothing when the folder has
  a signed-in profile (`--agent` for other agents).
- turno's own state files are checked before use: a cut or hand-edited file reads as absent
  instead of crashing, and an unreadable `mcp-managed.json` stops `turno mcp sync` and
  `turno uninstall` with a message naming the file (they used to go on as if it were empty).
  `turno identity log --verify` reports a line that is not an audit entry.
- `turno help environment` lists every variable turno reads and `turno help json` the JSON
  rules; every command help ends with examples. Colors honor `CLICOLOR=0`, `CLICOLOR_FORCE`
  and `TERM=dumb`; `TURNO_NO_UPDATE_NOTIFIER=1` turns the update check off.

---
"turno-cli": minor
---

`turno doctor` names the fix for every finding. Each warning and failure is followed by the
command that fixes it (`fix: turno profile repair work`, marked when `turno doctor --fix` runs it)
or the manual step, in sections (System, Config, Profiles, MCP, Look, Gateway) with icons and a
summary line (`12 ok, 2 warnings, 1 failure in 340ms`). `--json` adds `status`, `fix`, `auto` and
`manual` per check and `counts`, `ms` and `next` at the top. `--summary` prints one line for hooks
and status lines. `turno doctor --security` works the same way.

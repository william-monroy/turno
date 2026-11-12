---
"turno": minor
---

One command tree: `profile`, `limit`, `session` and `identity` group what used to be loose
commands, `run` opens a profile, and `config`, `undo`, `completion`, `version` and `upgrade`
are new. The 0.1 names (`setup`, `usage`, `exhausted`, `accounts`, `mcpd`, ...) and the Spanish
ones keep working. Every read command takes `--json`, every write command takes `--dry-run`
and can be undone with `turno undo`, `status` is a one-screen summary and `doctor --fix`
repairs what it can.

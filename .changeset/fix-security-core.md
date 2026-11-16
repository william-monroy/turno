---
"turno-cli": minor
---

Security hardening of secrets, state files and `turno open`:

- `turno secret set` and `turno mcp import --move-secrets` no longer pass the value as a command argument: on macOS it goes to `security -i` on stdin, so it never shows in the process list.
- Linux: `turno secret set|has|rm|list` and `keychain:` references in `mcp.toml` use the Secret Service through libsecret's `secret-tool` (attributes `service=turno`, `account=<name>`). Without a secret store turno prints one line suggesting `env:` references instead of a stack trace.
- turno's config, state and data folders are created with mode 0700 (existing ones are narrowed on first use), and the files turno writes there (`config.toml`, `mcp.toml`, `accounts.toml`, the audit log, backups) are 0600.
- Backups made before each change are private (0700 folders, 0600 files) and pruned: writing a new backup deletes those older than 30 days, always keeping the newest 10 and any backup that is still the only way back for a file. `turno undo --prune [--older-than 30d] [--keep 10] [--dry-run]` prunes by hand.
- The accounts bridge audit log is append-only and hash-chained: each line carries the hash of the line before it, so edits and deletions can be detected.
- `turno open` accepts only http(s) and mailto links, refuses arguments that start with `-`, treats `--help` as help, and works on Linux (`xdg-open`; claude.ai links open in an isolated Chrome profile when `google-chrome`, `google-chrome-stable` or `chromium` is on PATH).

# 0018. Secret storage on macOS and Linux, private file modes, backup retention

Date: 2026-11-16. Status: accepted.

## Context

A security review found that secrets did not stay where turno said they were:

- `turno secret set` and `mcp import --move-secrets` ran
  `security add-generic-password ... -w <value>`, so the value sat in the process list, where
  any local user, EDR agent or `eslogger` can read it.
- The Keychain item trusts `/usr/bin/security` (`-T`), so any process of the same user can read
  it without a dialog.
- `turno` state, logs, config and backups were created with the umask (folders 755, files 644):
  another local user could read MCP server logs, `accounts.toml`, `mcpd.port` and backups.
- Journal backups (ADR 0008) keep copies of configs that can hold literal secrets (an MCP
  server's API key before `--move-secrets`, the gateway token), and were never deleted.
- On Linux `secret set` failed with a `spawn security ENOENT` stack trace and a `keychain:`
  reference could not be resolved at all.

## Decision

### Secret store

- `core/secrets.ts` has a `SecretStore` (`get`, `has`, `set`, `remove`) chosen by platform:
  - macOS: the login Keychain through `security`. Items are generic passwords with service
    `<name>` and account `turno`.
  - Linux (and any other non-macOS system): the Secret Service through libsecret's
    `secret-tool`, with attributes `service=turno` and `account=<name>` and the label
    `turno: <name>`.
  - Neither: one line, `no secret store found: ... use env:NAME references in mcp.toml`. No
    stack trace; `ENOENT` is reported, not thrown.
- References keep the `keychain:<name>` spelling on every platform, so an `mcp.toml` moves
  between machines unchanged.
- A value never travels in argv. On macOS turno runs `security -i` and writes the
  `add-generic-password` command to its stdin (words double-quoted, `\` and `"` escaped; a
  value with a line break is refused, since the command is one line). `secret-tool store`
  reads the value from stdin. Tests run fake binaries that record their argv and assert the
  value is absent.
- turno never prints the output of a store command that received a value: an error line could
  quote the command.

### The `-T /usr/bin/security` trade-off (kept)

mcpd resolves `keychain:` references at spawn time by running
`security find-generic-password -s <name> -w`. Without `/usr/bin/security` on the item's access
list, every read would raise a Keychain dialog, for every MCP server start, in a background
daemon with no one watching. So the item keeps `-T /usr/bin/security`.

What that means, stated plainly: any process running as the same user can run the same command
and read the value without a prompt, including an agent session that has been prompt-injected
into running shell commands. Against that attacker the Keychain item protects as much as a file
with mode 600 does. It still beats a file: the value is encrypted at rest, it is not swept up by
backups, dotfile repositories or `grep -r`, it does not show up in config diffs, and other local
users cannot read it. (Items created by `security` normally trust `security` already, as the
creating application; `-T` states it explicitly instead of relying on that default.)

A better reader would be a small signed helper with its own access-list entry, so that only
that binary reads turno items without a prompt. That needs code signing and notarization in the
release pipeline; it is a possible follow-up, not part of this decision. The Secret Service on
Linux has no per-application access control at all: an unlocked collection is readable by
every process of the user over D-Bus, which is the same posture.

### Private folders and files

- `core/paths.ts` exports `ensurePrivateDir(dir, env)`. turno's three roots (config, state and
  data: `~/.config/turno`, `~/.local/state/turno`, `~/.local/share/turno`, or their
  `XDG_*_HOME` and `TURNO_*_DIR` variants) are created 0700, and an existing root with a wider
  mode is narrowed to 0700 the first time a process uses it. Folders inside them are created
  0700. Parents such as `~/.config` keep their mode.
- Files turno writes under those roots are 0600: journaled writes of its own files
  (`config.toml`, `mcp.toml`, `accounts.toml`), `accounts.toml` saved directly, the audit log,
  backup copies and manifests. Logs and `mcpd.port`, written by mcpd, use the same helpers
  (`ensurePrivateDir`, `PRIVATE_FILE_MODE`) so there is one rule in one place.
- Files outside the roots (Claude Code settings, terminal settings, launchers) keep the mode
  they had: they are the user's files and other programs expect their modes.

### Backup retention

- Backup folders are 0700 and every copy in them is 0600, whatever the original's mode.
- Writing a new backup prunes old ones: folders older than 30 days are deleted, but the newest
  10 are always kept. `turno undo --prune [--older-than 30d] [--keep 10] [--dry-run] [--json]`
  runs the same pruning by hand.
- A backup that is still the live undo point of a file is never pruned by age: when the journal
  has not been undone and a file it changed still holds exactly what the command left (its
  sha256 matches), its backup is the only copy of what that file held before, and
  `turno undo <stamp>` would still apply cleanly. Once the file changes again (or the change is
  undone), the backup ages out normally.
- An undo never prunes the journal it is reading from.

### Audit log

- `audit.jsonl` is opened append-only (`O_APPEND`), mode 0600 (narrowed if it was wider).
- Each line carries `prev`, the sha256 of the previous line as written (64 zeros on the first
  line). A lock folder next to the log keeps two writers from chaining to the same line.
- `verifyAudit()` in `accounts/audit.ts` checks the chain and reports the first broken line.
  It detects an edited, inserted, removed or reordered line and lines cut from the start. It
  cannot detect lines cut from the end, and anyone who can write the file can rebuild the chain:
  it shows accidents and naive edits, it is not a signature. Lines written before the chain
  existed are accepted as a legacy prefix.

## Consequences

- `turno secret` and `keychain:` references work on Linux desktops with a Secret Service
  (GNOME Keyring, KWallet with the Secret Service bridge, KeePassXC). Headless servers and
  containers usually have none; they use `env:` references.
- macOS users may see a one-time Keychain dialog if an item was created by another program;
  items turno creates read without one, as before.
- Old backups disappear after 30 days unless they are among the newest 10 or still the only way
  back for a file. A literal secret copied into a backup no longer lives forever.
- Existing installs get their folders narrowed to 0700 on first use; nothing else changes for
  the user.

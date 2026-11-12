# 0008. A journal for every write, and turno undo

Date: 2026-11-12. Status: accepted.

## Context

turno edits files the user owns: Claude Code settings, terminal settings, config.toml,
profile configs, launchers, fonts. 0.1 kept ad hoc backups in different shapes (`<stamp>/ui/<label>/`,
`<stamp>/config.toml`, `<stamp>/<profile>.claude.json`) and nothing could put them back, so
`migrate --rollback` was still on the list.

## Decision

- `core/journal.ts`: a command opens a `Journal`, and every write goes through it. Before the
  first change to a path it records whether the file existed and copies it to
  `backups/<stamp>/files/`; after the change it records the sha256 of what it left there.
  `journal.json` lists the entries. Writes follow symlinks (profiles link to the hub) and are
  atomic. A dry run records nothing.
- `turno undo <stamp|last>` restores each file, removes files the command created, and
  skips a file whose contents changed since (another program wrote it) unless `--force`. The
  undo is journaled too, so it prints the stamp that redoes the change.
- Commands that write print `undo with: turno undo <stamp>`.

## Consequences

- `migrate --rollback` is `turno undo <stamp of the migration>`.
- Backup folders from 0.1 have no journal; `undo --list` shows them as restore-by-hand.
- Files that are rewritten constantly by other programs (a profile's `.claude.json`) usually
  change after the journaled command; undo skips them by default rather than lose newer data.

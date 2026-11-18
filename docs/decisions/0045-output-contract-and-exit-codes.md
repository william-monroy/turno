# 0045. The output contract: --json, exit codes, state files and optional packages

Date: 2026-11-17. Status: accepted.

## Context

Scripts, hooks, status lines and agents read turno's output, and stage 4 of the wave 7
architecture review found it held together by habit, not by a contract:

- 29 calls to `printJson` and three bypasses (`turno secret list`, `turno resolve` and
  `turno mcp log` wrote `JSON.stringify` themselves). Nothing said which version of a shape a
  reader got, there was no way to ask for some fields or to learn which ones exist, and
  `turno limit show --watch --json` was a usage error.
- Errors were `turno: <message>` on stderr even under `--json`, so a program had to scrape text.
- Exit codes were 0, 1 and 2 plus 127 and 130, so a hook could not tell "no profile for this
  folder" from "mcpd is down" from "something broke".
- About 40 `JSON.parse(...) as T` casts read turno's own state files (locks, caches, the list of
  entries `turno mcp sync` wrote, journal manifests, audit and call log lines). A file cut short
  by a crash or edited by hand became a TypeError somewhere later, or worse, an empty list that
  made `turno mcp sync` forget the entries it had to remove.
- `loadBrowser` in `cli/commands/browser.ts` knew how to find an optional package next to the
  install or in the global npm folder; a second optional package (a future `turno-tui`) would
  have copied it.
- The help had no examples and no list of the environment variables turno reads, and colors
  ignored `CLICOLOR`, `CLICOLOR_FORCE` and `TERM=dumb` (the CLI UX research, patterns 6, 9, 10
  and 14).

## Decision

**One output layer** (`cli/output.ts`). Every JSON a command prints goes through `emit` (one
indented document, colored only on a terminal) or `emitLine` (one compact line). Each output
declares its schema next to the code that builds it: `jsonOutput(fields, version)`.

- Every object carries `schemaVersion` as its first key. A list has no room for one, so each of
  its elements carries it: lists stay lists, and no existing key moved or changed. All outputs
  start at version 1. Adding a field keeps the version; removing or renaming one, or changing
  what it means, raises it and goes in the changelog.
- `--json=fields` prints the field names and runs nothing (the group or `main` answers before the
  command starts, so `turno mcp top --json=fields` works with mcpd down). `--json=a,b` keeps only
  those fields (of each element, for a list), like gh's `--json`. An unknown field is a usage
  error (exit 2) that lists the known ones. A bare `--json` prints every field, as before.
- `--watch --json` and `--follow --json` print NDJSON, one record per line:
  `turno limit show --watch --json` (each profile, every 30 s), `turno mcp top --watch --json`
  (a snapshot every 2 s; `--watch` is new and also keeps the screen refreshing without a
  terminal) and `turno mcp log --follow --json`. `turno resolve --json` stays one line.
- Under `--json`, an error is one JSON line on stderr, with the exit code and its name:
  `{"schemaVersion":1,"error":{"code":"no_profile","exitCode":3,"message":"..."}}`; an unknown
  field adds `fields`, a bug adds `stack`. Without `--json` errors stay `turno: <message>`.
- The one exception: `turno config get --json` prints a config value as config.toml holds it
  (its shape is config.toml's), without `schemaVersion`, and refuses `--json=<fields>`.

**Exit codes** (`cli/exit.ts`, `turno help exit-codes`): 0 ok, 1 failure, 2 usage, 3 no profile
or rule for the folder, 4 the profile is not signed in, 5 the gateway is down; 127 (the agent's
command is not installed) and 130 (cancelled) stay, as shells use them. `UsageError` is 2 and
`CliError` carries its code from the enum. What changed:

| Command | Before | Now |
|---|---|---|
| `turno auto`, folder rule naming a profile that does not exist | 1 | 3 |
| `turno auto`, no rule and no default with `system = ""` | 1 | 3 |
| `turno mcp daemon status` (and `turno mcpd status`) with mcpd down | 1 | 5 |
| `turno mcp top`, `turno mcp savings` with mcpd down | 1 | 5 |
| `turno limit show --watch --json` | 2 (refused) | 0, NDJSON |
| `turno config get <missing> --json` | 1, text on stderr | 1, JSON error on stderr |
| `turno identity log --verify`, a JSON line that is not an audit entry | 0 (not checked) | 1 |
| `turno mcp sync`, `turno uninstall` with an unreadable `mcp-managed.json` | went on as if empty | 1, names the file |

A missing launcher stays 1: the profile exists, its install is broken. Codes 3 and 4 are not
used for `turno <profile>` (a name that is neither a command nor a profile is still 2).

**`turno profile which --check`** answers with the code: 0 when the folder has a profile that is
set up and (for Claude Code, the agent turno reads an account for) signed in, 3 without one, 4
when it is not signed in, 1 when its launcher is missing or `claude auth status` gives no
answer. It prints nothing on success and one line on stderr otherwise; with `--json` it adds a
`check` field. `--agent` checks another agent's profile.

**State files** (`core/state-file.ts`). `readState(file, guard, version)` reads JSON that turno
wrote, checks it with a small hand-written guard (no schema library: the status line loads this
on every prompt) and returns undefined when the file is missing or cannot be used, the safe
default for caches and hints. `requireState` returns undefined only when the file is missing
and throws a one-line `StateError` (fix or remove it) otherwise, for state whose loss would make
turno act wrongly: `mcp-managed.json`, which says which entries `turno mcp sync` and
`turno uninstall` may remove. `parseState` does the same for one line of a log. Versions: an
object may carry `version`; a file without one is format 1, which is every file written so far,
so no writer changed. A file whose version is above what the reader knows came from a newer
turno and is not read. Readers moved: the mcpd lock and start error, the server description
cache, `mcp-managed.json` (strict for sync and uninstall, lenient for doctor), the synced token
list, the RSS samples, client names, the update check, journal manifests (one that does not
parse is shown as restore-by-hand, as before), audit and call log lines, and the usage snapshot.
Files of other programs (Claude Code's `.claude.json`, settings, transcripts) and command output
keep their own checks (`parseJsonObject`, ADR 0032).

**Optional packages** (`cli/optional.ts`). `loadOptional(pkg, { global, guard })` loads a package
installed apart from turno-cli: next to the install, then from the global npm folder. A missing
package is undefined; a module the guard rejects is a CliError that names the update command, not
a TypeError later. `OPTIONAL` lists `turno-browser` and `turno-tui`; `loadBrowser` is
`loadOptional(OPTIONAL.browser, { guard })`.

**Help and environment.** `turno help environment`, `turno help exit-codes` and `turno help json`
are static topics (no command module loads). Every command help, and every subcommand's, ends
with `Examples:`; a group's examples are filtered for each subcommand. Colors add, after
`FORCE_COLOR` (ADR 0037): `CLICOLOR_FORCE` not 0 turns them on, also in a pipe; then
`CLICOLOR=0` or `TERM=dumb` turns them off. `TURNO_NO_UPDATE_NOTIFIER` turns the update check
off like `TURNO_NO_UPDATE_CHECK` (gh's name).

## Consequences

- Programs can rely on `schemaVersion`, ask for fields, follow NDJSON, and read errors and exit
  codes without scraping text. A test runs `--json=fields` on every subcommand that takes
  `--json`, so a new one cannot ship without its schema; another checks that every `TURNO_*`
  name in the source is in `turno help environment`, and that every help ends with examples.
- Scripts that tested `turno auto` or the mcp commands for exit 1 see 3 or 5 now (the table
  above). The changeset lists them.
- Lists gained `schemaVersion` in each element instead of a wrapper object, which keeps
  `jq '.[].name'` working; a reader that compared whole objects with `==` needs to drop it.
- A corrupt `mcp-managed.json` stops `turno mcp sync` until it is fixed or removed, instead of
  leaving stale gateway entries behind silently.
- `turno --help` and `turno statusline` load nothing new: the output layer loads with the
  commands that print JSON, `turno help <topic>` loads only `topics.ts`, and `state-file.ts`
  imports only `node:fs` (the lazy import and help tests still pass).

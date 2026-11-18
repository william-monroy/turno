# 0050. Moving MCP servers between machines, OAuth detection, Codex trust and next-step hints

Date: 2026-11-18. Status: accepted. Builds on ADR 0023 (per-profile tokens and variants), ADR
0029 (OAuth for remote servers), ADR 0031 (folder server sets), ADR 0032 (the agent registry) and
ADR 0049 (diagnostics).

## Context

- **mcp.toml could not leave the machine safely.** Copying it to a second machine (or sharing a
  team's server list) carried every literal secret in `env` and `headers`, and `turno mcp import`
  only read the agent configs of this machine and replaced `mcp.toml` as a whole.
- **OAuth servers came in as direct remotes.** An imported hosted server that needs a login was
  written into profiles as a plain URL, so each agent ran its own login, or failed, until the
  person added `auth = "oauth"` by hand.
- **Codex asked about trust once per profile.** Codex keeps "do you trust this folder?" in each
  `CODEX_HOME`'s `config.toml`, so every new Codex profile asked again in folders the person had
  already trusted and given a rule.
- **Some writes ended without saying what comes next.** `profile add` printed a next step;
  `mcp import --write`, `profile assign` and `secret set` did not, though each has an obvious one.

## Decision

### `turno mcp export [--profile p]`

Prints `mcp.toml` on stdout (status lines on stderr), parsed and re-serialized, without secret
values:

- `keychain:` and `env:` references stay.
- A literal secret in `env` or `headers` (the same detection as the import) becomes
  `keychain:turno/<server>/<key>`, or `turno/<server>/<profile>/<key>` in a variant: the names
  `--move-secrets` uses, so an exported file and a moved import agree.
- A secret inside `args` or a URL has no reference form, so it becomes `<secret>` and the export
  says where.
- A comment block at the top lists `turno secret set <name>` for every Keychain name the servers
  use, and the variables mcpd reads.
- `--profile` keeps the servers that profile gets and only its variant. `--json` gives the text
  and the lists. The output is parsed with the manifest parser before it is printed.

The format is `mcp.toml`'s own, not a new one: an export is a valid `mcp.toml`, so there is one
parser and one set of docs. The secret marker the request suggested (`secret:`) would have been a
third reference kind; the existing `keychain:` names are what the receiving machine needs to run
`turno secret set`, so they are the marker.

### `turno mcp import <file>`

With a file, import merges instead of replacing. The file is either `mcp.toml`'s format (an
export) or another agent's config (`mcpServers` JSON, Codex `[mcp_servers]` TOML, converted as
the import without a file converts them; gateway entries skipped). New servers are appended as
text, so the rest of `mcp.toml` and its comments stay; a name already there is kept unless
`--force`, which removes that server's tables (`[server.<n>]` and its sub-tables) and appends the
new ones. A server written another way (an inline table under `[server]`) is refused with "edit
it by hand" rather than rewritten. A preview prints only names, so a literal secret from another
agent's config never reaches the terminal. `--write` goes through the journal (`turno undo`).

### OAuth detection on `--write`

Each remote server with no auth of its own (no `auth`, no `Authorization` header, no header with
a secret, a reference or a variable) gets one unauthenticated `initialize` POST with a 5 second
limit. A `401` with `WWW-Authenticate: Bearer ...`, the challenge the MCP authorization spec
requires, sets `auth = "oauth"`; anything else (another status, an error, a timeout, a redirect)
leaves the server as it was. Previews stay offline, as they already did for npm lookups. Both
import forms use it.

### Codex `[projects]` trust entries

A new optional adapter hook, `ruleFolders`, runs when folder rules point at a profile:
`turno profile assign` after it writes the rule, and `turno profile repair` for every rule of the
profile. Codex implements it by adding

```toml
[projects."<folder>"]
trust_level = "trusted"
```

to the profile's `config.toml` (Codex's own key, as its config reference documents), for the
rule's folder and for its real path when a symlink leads there. Existing entries, including
`untrusted`, are never touched; the edit is textual (comments stay), checked by parsing, and
journaled. Codex matches the exact folder or the git root of the session's folder (the main
repository for worktrees), so a rule on a parent folder of several repositories does not trust
them; docs/agents.md says so. Claude Code, Copilot and Cursor have no hook.

### Next-step hints and `hints = false`

`nextStep(io, steps)` prints one `Next: a; b; c` line, never under `--json`, and nothing when
`hints = false` in config.toml (`turno config set hints false`). Used by `profile add`,
`profile assign`, `mcp import --write` (both forms: secrets still to store, `mcp install`,
`mcp login` for marked servers, `mcp sync`), `mcp export` (on stderr) and `secret set`.

## Consequences

- An `mcp.toml` can be shared in a repository or a team chat; what the other side needs is the
  list of `turno secret set` names at the top.
- A remote server that answers 401 for reasons other than OAuth, with a Bearer challenge, is
  marked; `turno mcp login` then fails with the server's answer and the person removes `auth`.
- Trusting a folder is a security decision. turno only writes it for folders the person has
  explicitly given a Codex profile, never for parents or children of them, and keeps a previous
  `untrusted` answer.
- Exported files lose comments; the import of a file keeps the receiving `mcp.toml`'s comments.

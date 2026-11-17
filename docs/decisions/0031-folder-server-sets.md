# 0031. MCP server sets per folder

Date: 2026-11-16. Status: accepted.

## Context

`mcp sync` writes every server of a profile into that profile's agent config, so every session
of the profile loads every server's tool descriptions, whatever folder it works in. A client
repository may need its issue tracker and docs and nothing else; an open-source checkout should
not see the mail connector. Agents offer project-level MCP configs, but each has its own file
and format, and turno's gateway entries live in the user config. mcpd already knows each
session's folder (ADR 0016) and profile (ADR 0023), and applies per-profile tool filters.

## Decision

**A folder rule may carry a server set.** `[[projects]]` in `config.toml` gains `mcp` (only
these servers, by their name in `mcp.toml`) and `mcp_deny` (not these). A rule needs a profile,
a set, or both; a rule with only a set does not take part in profile resolution. Names are
exact, not globs: they are checked against `mcp.toml` by `turno config check` (and so by
`turno doctor`), which warns about unknown names with a suggestion, and about direct remote
servers the set would hide, since those never pass through mcpd.

**Which rule.** Among the rules with a set that cover the session folder (or, for a git
worktree, its main repository, as `turno auto` does for profiles), the longest path wins. On a
tie the rule of the session's profile wins, else the first in the file. A nested rule replaces
its parent's set; a nested rule without a set leaves the parent's in force, because it says
nothing about servers. The set is the folder's: it applies to every profile's sessions there.

**mcpd hides, sync does not change.** Agent configs stay per profile and list every server.
mcpd decides per session: a server outside the set answers `initialize` itself with no
capabilities and an `instructions` line naming the rule, answers every list with an empty list,
refuses other requests with a JSON-RPC error naming the rule, drops notifications, and never
starts the upstream. We did not refuse the session with HTTP 403: agents show a refused server
as a failure (and some retry it), while an empty server is quiet and costs nothing. A session
whose folder mcpd cannot learn (no header and no process folder) sees every server.

**Live config.** mcpd now reloads `config.toml` when it changes and on SIGHUP, keeping the last
good rules when the file is broken (the error shows in `/status`, with the number of sets). The
gateway reads the rules on every request, like tool filters, so a changed set applies to open
sessions on their next list or call. A session that was hidden when it initialized keeps no
capabilities until the agent reconnects it.

**Commands.** `turno profile which <dir>` shows the set of a folder (and `--json` gives it).
`turno profile assign`, `unassign` and `profile remove` change only the profile part of rules:
a replaced rule passes its set to the new one, and a removed profile rule leaves its set behind
as a rule of its own.

## Consequences

- A folder can cut both the memory of servers it never uses and the tokens of their tool
  descriptions, without per-agent project files.
- The agent still lists a hidden server (connected, no tools). Removing it from the list would
  need a config per folder, which the agents do not share.
- The set is enforced by mcpd only. Direct remote servers and servers an agent loads by itself
  (plugins, project `.mcp.json`) are not covered; `config check` names the remotes.
- Folder matching uses the folder the session reports when it starts; an agent that changes
  folder mid-session keeps the set of the folder it started in.

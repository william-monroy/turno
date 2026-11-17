# 0032. The agent adapter boundary

Date: 2026-11-16. Status: accepted. Refines ADR 0013.

## Context

ADR 0013 promised that a new agent would be "a new adapter file plus tests; the CLI commands do
not change". In practice the adapter held names and prefixes while the differences lived in the
commands: about fifteen `agent === "codex"` (or `"claude"`, `"cursor"`) branches in `mcp sync`,
the gateway entry builder, the launcher generator, profile setup, doctor, `turno init`, the MCP
importer and `doctor --security`. The Claude Code adapter left its shared lists empty and pointed
at `cli/launchers.ts` and `setup.ts`; `launcherEnv` held raw shell lines. Adding Gemini CLI or
opencode as a profile agent would have touched half a dozen commands.

## Decision

**One file per agent, one registry.** `src/agents/<id>.ts` exports an `AgentAdapter`
(`src/agents/adapter.ts`); `src/agents/index.ts` lists the ids (`AGENT_IDS`), maps them to
adapters, and holds two orders: the display order (`AGENT_IDS`) and `SCAN_ORDER`, the order turno
reads agent configs in (`mcp import`, where the first source wins a name, and
`doctor --security`). A test checks that every id has an adapter and appears once in
`SCAN_ORDER`.

**What the adapter owns.** Data: command, label, install hint, home variable, folder and
launcher prefixes, hub, home markers (for `turno init`), shared folders and files, the items a
profile owns (`perAccount`, so doctor can flag unclassified ones), launcher environment as
name/value pairs that the generator quotes, whether the launcher exports the gateway token,
whether turno can read the signed-in account, and the sign-in subcommand. MCP: the store format
(`json` under a key, or `toml` tables under a key), the profile's file and the hub's file, a
folder file and per-project servers (Claude Code), conversion to Claude Code's shape for
import (Codex), whether direct remote servers are written, the gateway entry, and a line to print
after sync adds servers (Cursor). Behavior: optional setup steps around the shared links
(`before`, `hold`, `after`) that get a small context (folder, hub, journal, `writeOwn`, `busy`)
from `turno profile repair`, and doctor warnings about the profile folder.

**What stays outside.** The commands own the generic flow: linking, the journal, launcher text,
sync planning, doctor's launcher and link checks, the importer's merge. Three ideas are not
per-agent branches and stay as they are:

- `DEFAULT_AGENT` (Claude Code): the agent of a profile without `agent =`, the owner of the
  top-level `default`, `fallback` and `system`, and the agent messages do not name.
- `classicLauncher`: Claude Code launchers keep the text they had before other agents existed
  (header naming the hub, a comment on BROWSER, no `TURNO_AGENT`), and doctor only flags bash
  claudio ones instead of comparing the whole text. New agents use the regular format.
- Claude-only features: the status line, usage windows, `limit`'s usage view and session
  handoff read Claude Code's own files and commands. They ask for Claude Code profiles by
  name (`listProfiles(config, env, "claude")`), as ADR 0013 decided.

**Light adapters.** Adapter files import only `node:` modules, `core/paths`, `core/toml-edit`,
`cli/io` and smol-toml (already loaded by `core/config`), so every command can import the
registry without slowing `turno auto` or the status line. Hooks get what they need through
their context instead of importing commands.

**Guard.** A test scans `src/` outside `src/agents/` for comparisons and `case` labels on agent
ids and fails on any.

## Consequences

- A new agent is a new adapter file, its id in `AGENT_IDS` and `SCAN_ORDER`, its entry in the
  registry map, and tests. TypeScript requires every adapter field.
- No output changes: launchers, gateway entries, setup and doctor messages are byte for byte
  what they were (checked with a golden run of every command before and after).
- `syncServers(file, store, ...)` is the one entry point for writing MCP entries; `uninstall`
  picks the store from the file extension, since its record of managed files holds no agent.
- `agentHub`, `agentProfileDir` and `mcpFileFor` now require `env` (H15: no silent fallback to
  the real HOME).

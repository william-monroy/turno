# 0026. Call log, `turno mcp top` and `turno mcp savings`

Date: 2026-11-16. Status: accepted.

## Context

mcpd sees every tool call of every agent session (Claude Code, Codex, Copilot CLI, Cursor), but
until now it kept no record of them: `mcpd.log` says when servers start and stop, not which tool
was called, by whom, how long it took or why it failed. No agent offers this across agents, and
it is the first thing to look at when "the MCP tool hangs" (ideas 3 and 4 of the 2026-11-16
review).

`turno mcp daemon status` printed one memory number per process, but nothing about sessions per
server, calls in flight or restarts, and it never refreshed. The README's memory claim (one
process per server instead of one per session) could not be checked on the user's own machine.

## Decision

**Call log.** The instance manager takes an `onCall` hook that runs after every relayed request
settles (`InstanceManager.forward`), with the session context, the method, the variant, the
outcome and the duration. A hook failure never fails the call. `mcpd/calllog.ts` turns
`tools/call` events into one JSON line in `state/logs/calls.jsonl`:

```json
{"time":"...","agent":"claude-code","profile":"work","pid":4242,"server":"github","variant":"work","tool":"create_issue","durationMs":812,"outcome":"ok","requestBytes":431,"responseBytes":2210}
```

- `outcome` is `ok`, `error` (a JSON-RPC error, or a result marked `isError`), `cancelled` (the
  client cancelled or went away) or `timeout` (`call_timeout`). Failed calls add `error`: the
  JSON-RPC message, with bearer values, `key=value` pairs named like secrets, known token
  prefixes and long mixed letter and digit strings replaced by `[redacted]`, cut at 300
  characters. For `isError` results the text is a result, so it is not kept.
- A record never holds arguments or results, only the byte size of their JSON.
- `agent` is `clientInfo.name` from `initialize` (printable, at most 64 characters). A session
  rebuilt after a restart takes the name its process gave before: from another session of the
  same PID, or from `state/mcpd-clients.json` (PID to name, mode 600, dead PIDs dropped).
- Writes are synchronous appends (records keep their order), mode 600, rotated at 5 MiB with two
  old files, like `mcpd.log`. A disk that refuses writes is reported once in `mcpd.log` and never
  takes mcpd down.
- `[mcpd] call_log = false` in config.toml turns it off at the next mcpd start. The key is in
  `KNOWN_KEYS` and `turno config set`.

`turno mcp log [-f] [-n N] [--server S] [--profile P] [--json]` prints the last N matching records
(reading rotated files only when more are needed) in local time, or one JSON record per line.
`-f` polls the file every 500 ms, so it works everywhere and survives a rotation.

**Status.** `/status` (bearer token, as before) gains `agents` (one entry per client PID, or per
session without one: profile, client name, servers), `instances[].restarts` (starts of the same
instance key after the first; the counter is dropped when the key cannot return), `callLog` and
`serverRss`.

**Memory.** `mcpd/rss.ts` reads one process table, `ps -A -o pid=,ppid=,rss=` (macOS and Linux),
else `/proc/<pid>/status` on Linux, else nothing: callers then say memory is unknown instead of
printing 0. A server's memory is its process plus all descendants, because `npx`, `uvx` and
shell wrappers start the real server as a child. The CLI measures live; mcpd samples its
instances every 15 seconds while any runs and keeps the last value per `server@variant` in
`state/mcpd-rss.json` (mode 600), so an estimate can include servers that are idle now.

**`turno mcp top [--once] [--json]`** shows mcpd (own memory, memory with its children, sessions,
agents, uptime) and per instance: PID, memory, sessions, calls in flight, idle time, restarts,
uptime and the holder of an exclusive lease. It refreshes every 2 seconds in a terminal until
Ctrl-C and prints one snapshot otherwise.

**`turno mcp savings [--json]`** compares mcpd plus its children now with an estimate without the
gateway: for each live agent session (a client PID), every stdio server its profile gets, at that
server variant's memory (live, else the last sample, else any variant of the same server). The
output says this in one line and lists servers that were never measured and sessions without a
PID, which are left out rather than guessed. When there are few sessions and mcpd costs more than
it saves, it says so.

The code lives in new files (`mcpd/calllog.ts`, `mcpd/rss.ts`, `cli/commands/mcp-observe.ts`);
`gateway.ts`, `instances.ts` and `daemon.ts` only gain the hook, the counters and the wiring.

## Consequences

- Each logged call serializes its params and result once more to measure them. For the large
  bodies the gateway allows (32 MiB) that is a few milliseconds of CPU; turning the log off
  removes it.
- While servers run, mcpd forks `ps` every 15 seconds.
- RSS counts shared pages in every process, so both sides of `savings` overcount a little in the
  same way; the estimate ignores that agents load servers at session start and assumes every
  configured server would run, which is what agents do without a gateway.
- Tool names, profiles and error texts are on disk. They stay in the private state folder with
  mode 600, are bounded by rotation, and can be turned off.
- Sessions that send no PID (a client that is neither launched by turno nor found by `lsof`) are
  not counted in `savings`.

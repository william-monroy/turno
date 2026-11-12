# 0002. One HTTP gateway instead of per-session stdio shims

Date: 2026-11-12. Status: accepted.

## Context

Claude Code starts every configured stdio MCP server in every session. Options considered:

1. Per-session lazy shims: a small stdio process per server per session that answers
   `tools/list` from a cache and starts the real server on first call. Still one process per
   server per session (about 40 MB each for Node).
2. An aggregator exposed as a single MCP server. Renames every tool
   (`mcp__claudio__calcom_x`), breaking skills and permission rules that name tools.
3. One local daemon that serves each server on its own HTTP path. Claude Code connects with
   `type: "http"`, so a session costs no local process at all, and tool names stay the same.

## Decision

Option 3 (`mcpd`). Headers identify the caller: the profile is written literally per profile
config, and `X-Claudio-Pid: ${CLAUDIO_SESSION_PID:-0}` is expanded by Claude Code. Expansion of
environment variables in user-scope HTTP headers was verified on 2026-11-12 against Claude Code
with a probe server (`claude mcp list` sent `X-Claudio-Pid: 4242` and `X-Claudio-Profile: work`).

## Consequences

- mcpd must be running; `claudio doctor` and the LaunchAgent keep it alive.
- If mcpd is down, sessions see the servers as failed instead of slow; acceptable.
- Plugin-provided stdio servers bypass the gateway; `claudio mcp doctor` reports them.

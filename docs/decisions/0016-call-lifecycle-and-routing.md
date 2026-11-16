# 0016. Call lifecycle and server-to-client routing in mcpd

Date: 2026-11-16. Status: accepted.

## Context

An audit of the gateway (findings 01-H1, H2, H5 to H9, H11, H13, H14 and 03-H5, H10) found
that calls could stay "in flight" forever, that a reload did not reach open sessions, and that
requests a shared server sends back to its client (elicitation, roots, logs) went to whichever
session had the last call in flight. On stdio nothing ties a server request to the call that
caused it, so any rule is a choice between guessing and refusing.

## Decision

**Every relayed request settles exactly once.** It ends with the server's answer, or with an
error from mcpd when: the client sends `notifications/cancelled` (mcpd forwards it and settles
at once with -32800, since a server must not answer a cancelled request); the client session
closes or its process dies (mcpd cancels each of its calls upstream); the server's optional
`call_timeout` passes (mcpd cancels upstream, -32001); or the server stops. `inflight` then
returns to 0 and idle reaping works. The accounts bridge passes the MCP abort signal down to
the delegated run, kills its process group and audits the outcome as `cancelled`.

**Sessions keep a server name, not a definition.** Each use looks the definition up in the
current manifest; a removed server answers a JSON-RPC error. The instance key includes a
fingerprint of the whole definition (launch, scope, cwd, exclusive, idle, lease, timeouts), so
an instance started with an old definition never takes new calls, and the reaper stops it once
it is quiet.

**Server-to-client requests are routed, or refused.** In order: a `_meta.relatedRequestId`
naming one of mcpd's upstream request ids; else the one client with calls in flight; else the
only attached client. With calls in flight from more than one client, mcpd answers -32004 with
a message that suggests `scope = "session"` or `exclusive = true`. Log notifications follow the
same rule and are dropped when ambiguous. mcpd offers `elicitation` and `sampling` to a server
only when the client that starts it declared them (a client with unknown capabilities, such as
a recreated session, gets form elicitation as before), and checks the routed client's
capabilities before relaying. `roots/list` is answered by mcpd from the instance folder for
project and session servers; shared servers are not offered roots.

**The session folder travels encoded.** Launchers export `TURNO_SESSION_CWD_B64` (base64url of
the UTF-8 path) and gateway entries send it as `X-Turno-Cwd-B64`. Without it mcpd reads the
client process's folder from its PID. The old `X-Turno-Cwd` is still accepted, with Latin-1
mojibake repaired. A folder that does not exist fails the start with a message naming it.

**Descriptions follow the server.** Every real start relists tools, prompts and resource
templates; a change updates the cache and sends `list_changed` to the clients of that
description (mcpd announces `listChanged` itself). `resources/list` is no longer cached.
`POST /refresh[/<server>]` relists running instances and forgets the rest.

**Failures are bounded.** After 3 failed starts in a row a server's breaker opens: calls fail
at once with the tail of its log, and the next try waits 5 s, doubling up to 5 minutes. A remote
proxy whose server answers 404 to our session is closed and the call retried once on a fresh
connection; `type = "sse"` uses the SSE client transport.

**Restarts do not end conversations.** A request with an unknown `mcp-session-id` (a UUID, on
POST or GET, with a valid token) rebuilds the session under the same id from its headers. The
SDK has no public way to adopt a session id, so mcpd sets two fields of its inner transport;
the SDK version is pinned and a test covers it, and if the fields move mcpd falls back to 404.
The rebuilt session does not know the client's capabilities, so it is treated as supporting
form elicitation.

Also: an exclusive lease does not expire while its holder has a call in flight; session servers
do not idle out while their owner PID lives; the project root is computed once per session with
an async `git` call; request bodies up to 32 MiB are accepted; `resources/subscribe` is tracked
per client so updates reach only subscribers; server logs rotate by size while running.

The `npx -y` fallback for a declared but uninstalled `package` stays, with a warning in the
server log and mcpd's log: `mcp import` writes `package` and `mcp install` is a separate step,
so an error would break imported setups that work today.

## Consequences

- `scope = "shared"` servers that elicit or sample can refuse a request while another session
  is mid-call. That is visible and safe; the fix is a narrower scope.
- An upstream started by a client without elicitation never elicits, even for later clients
  that support it, until it restarts.
- Subscriptions are lost when an instance restarts; clients must subscribe again.
- `call_timeout` also cuts calls waiting on a person (elicitation), so it is off by default.
- Session recreation depends on SDK internals; upgrading the SDK must keep that test green.

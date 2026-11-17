# 0028. MCP revision 2026-07-28 next to 2025-11-25, and idle limits under memory pressure

Date: 2026-11-16. Status: accepted.

## Context

**Protocol.** MCP revision 2026-07-28 makes the protocol stateless: no `initialize` handshake,
no `Mcp-Session-Id`, the protocol version, client capabilities and client identity travel in
every request's `_meta`, and Streamable HTTP POSTs must mirror the method and the tool, prompt or
resource name in `Mcp-Method` and `Mcp-Name` headers. List results gain `ttlMs` and
`cacheScope`, server-to-client requests become multi round-trip results (MRTR), and the GET
stream and `resources/subscribe` give way to `subscriptions/listen`. Some gateways already
require 2026-07-28 clients, and agents ship SDKs that speak it, with legacy negotiation only as a
fallback (05 market notes, idea 7). mcpd negotiated only up to 2025-11-25: a client that sent a
2026-07-28 request without a session got the SDK's "server not initialized" 400 and, since that
is not a recognized modern error, fell back to `initialize`. That works today, but only as long
as clients keep the fallback.

The installed SDK, `@modelcontextprotocol/sdk` 1.32.2 (the last v1 release), knows nothing of
2026-07-28 (`LATEST_PROTOCOL_VERSION` is 2025-11-25). The v2 SDK (`@modelcontextprotocol/server`,
`client` and `core` 2.x, stable since 2.0.0 on 2026-07-27, now 2.4.0) implements it.

**Memory.** Idle servers stop after `idle` (30 minutes shared, 20 others). On a laptop that is
short of memory those minutes are exactly when the RAM is needed (idea 14, idea 9 of the review).

## Decision

### Stay on SDK v1; serve 2026-07-28 in mcpd's own HTTP layer

Moving to SDK v2 means new packages and import paths for the gateway transport, the upstream
transports and the connectors, the same files the OAuth work for remote servers changes now,
and it does not remove mcpd's own routing (shared instances, leases, request id rewriting). So
the SDK stays at 1.32.2 for 2025-11-25 sessions and for talking to upstream servers, and
`mcpd/modern.ts` serves 2026-07-28 requests directly. A later ADR can move both sides to v2.

**Which way a request goes** (`wantsModern`): a POST whose `MCP-Protocol-Version` is set and is
not a 2025-era version (`SUPPORTED_PROTOCOL_VERSIONS` of the SDK) and that carries no
`Mcp-Session-Id` goes the stateless way; so does a 2026-07-28 request with a session id, which
that revision says to ignore. Everything else (initialize, session traffic, GET, DELETE) goes to
the SDK transport exactly as before. mcpd reads the body itself for stateless requests (with the
same `max_request_body` limit); an `initialize` that arrives with a newer version header is
handed to the SDK with the parsed body, so dual-era clients still get a 2025-11-25 session.

**Validation, as the revision requires.**

- `MCP-Protocol-Version` not 2026-07-28: 400, `UnsupportedProtocolVersion` (-32022) with
  `data.supported` (2026-07-28 first, then every 2025-era version) and `data.requested`.
- `Mcp-Method` missing or different from the body, `Mcp-Name` missing or different from
  `params.name` / `params.uri` (after decoding the `=?base64?...?=` form) on `tools/call`,
  `prompts/get` and `resources/read`, or the `_meta` version different from the header: 400,
  `HeaderMismatch` (-32020).
- `_meta` without `io.modelcontextprotocol/protocolVersion` or `clientCapabilities`: 400, -32602.
- `Mcp-Param-{Name}` headers for tool parameters annotated with `x-mcp-header` (reachable through
  `properties` only) must match the arguments: integers compared as numbers, booleans as
  `true`/`false`, Base64 form decoded. A missing header for a present value, or a header for an
  absent value, is a `HeaderMismatch`. The tool definition comes from the description cache.
- Unknown methods, and methods the revision removed (`ping`, `logging/setLevel`,
  `resources/subscribe`, `resources/unsubscribe`): 404, -32601.
- A notification: 202 with no body (none is defined for HTTP in this revision).

**Who the client is.** There is no session, but mcpd's routing needs a stable client: exclusive
leases, session-scoped instances keyed by PID, the call log and `/status`. A `StatelessClient`
stands for each profile, server, client PID (`X-Turno-Pid`, else the TCP peer, looked up once
per connection) and folder header. Its context (folder, project root) is built once, like a
session's; its capabilities and client name are refreshed from each request's `_meta`. Clients
are dropped when their PID exits or after 30 minutes with nothing in flight and no listen stream,
which also releases their leases and subscriptions. `/status` lists them under `agents`.

**What mcpd answers.**

- `server/discover`: `supportedVersions`, the capabilities mcpd announces (with `listChanged`,
  without the 2025-11-25 `tasks` capability, which is an extension in 2026-07-28), instructions,
  caching hints and `_meta["io.modelcontextprotocol/serverInfo"]`.
- `tools/list`, `prompts/list`, `resources/templates/list`: from the description cache, with the
  profile's tool filter (ADR 0023), as for sessions.
- Everything else is relayed through the instance manager like a session's request. The
  `io.modelcontextprotocol/*` keys are removed from `_meta` before the call goes upstream (the
  servers speak 2025-11-25); `progressToken` and trace context stay. Every result gets
  `resultType: "complete"` when the server did not set one, and the server's identity in `_meta`.
  mcpd uses its own request id upstream, so two requests of one client never collide.
- The response is JSON, or SSE when the request asked for progress (`progressToken`) or logs
  (`io.modelcontextprotocol/logLevel`). Log messages go only to a request that asked for a level,
  at that level or above. Closing the response cancels the upstream call (the revision's
  cancellation), which settles it, so the instance can still idle out.
- Error codes the revision forbids are mapped: -32002 becomes -32602 on `resources/read`
  (resource not found moved there) and -32603 elsewhere (mcpd's own "server unavailable"), and
  -32042 becomes -32603.
- `subscriptions/listen` opens an SSE stream on the same client. mcpd acknowledges the subset it
  honors (`toolsListChanged`, `promptsListChanged`, `resourcesListChanged` when the server has the
  capability; `resourceSubscriptions` when it supports `resources.subscribe`, one upstream
  subscription per URI as for sessions), sends nothing before the acknowledgment (what arrives
  meanwhile waits for it), tags every
  notification with `io.modelcontextprotocol/subscriptionId`, sends an SSE comment every 25
  seconds, unsubscribes upstream when the stream closes, and ends streams with a `complete`
  result when mcpd stops.

**`ttlMs` and `cacheScope` from the description cache.** The cache already knows when a list was
last read from a running server (`updatedAt`). A list relisted since this mcpd started
(`InstanceManager.verified`) gets `ttlMs` 300000 (5 minutes); mcpd relists after every start and
on every upstream `list_changed`, and listen streams get the change at once. A list that only
comes from disk (a previous mcpd run, the server not started since) gets `ttlMs` 0: it may be
stale, and asking mcpd again is a local cache read, so the client should not keep it.
`cacheScope` is always `"private"`: lists differ by profile (variants, tool filters), and the
profile token is the authorization context, so a shared cache must not serve one profile's list
to another. `resources/list` and `resources/read` are not cached by mcpd and get `ttlMs` 0,
`"private"`.

### Gaps, kept compatible and documented

- **Server-to-client requests (MRTR).** A 2026-07-28 client answers elicitation, sampling and
  roots only by retrying its request with `inputResponses`. mcpd does not turn an upstream
  `elicitation/create` or `sampling/createMessage` into an `InputRequiredResult` yet: it would
  have to hold the upstream request open across the client's retry. Those capabilities are not
  offered upstream for stateless clients, and a request that still arrives gets -32601 at once
  instead of hanging. `roots/list` keeps working for project and session servers, which mcpd
  answers from the folder headers. Agents that need elicitation through mcpd keep a 2025-11-25
  session, which they get by falling back to `initialize`.
- **Tasks extension** (`io.modelcontextprotocol/tasks`) is not offered.
- **Upstream servers** are spoken to as 2025-11-25 clients; a server that only speaks
  2026-07-28 cannot sit behind mcpd yet.
- **Pagination**: lists from the cache come in one page, as for sessions.

### Idle limits under memory pressure

`mcpd/pressure.ts` reads one level, `normal`, `warn` or `critical`, before each reap (every 15
seconds):

- macOS: `sysctl -n kern.memorystatus_vm_pressure_level` (1, 2, 4), the kernel level that
  `memory_pressure` reports. Free memory is no fallback there, because it leaves out reclaimable
  caches; a failed sysctl counts as normal.
- Linux: `/proc/pressure/memory` (PSI): warn at `some avg10` >= 10, critical at `some avg10` >= 40
  or `full avg10` >= 10.
- Elsewhere, or Linux without PSI: free memory below 10 % is warn, below 5 % critical.

Under warn the idle limit of every instance becomes `min(idle, idle_under_pressure)`, under
critical `min(idle, idle_under_pressure / 4)`. The limit never grows, in-flight calls still keep
an instance, and a session server whose launcher lives is still kept (its state is the point).
The reaper reports `idle (memory pressure)` and mcpd.log notes each level change.

`[mcpd] idle_under_pressure` in config.toml: a duration between 30 seconds and 24 hours (`"5m"`,
`"90s"`, or seconds), default `"5m"`; `false` turns it off. `turno config set` validates it. The
probe is injected into `InstanceManager` (`pressure`, `idleUnderPressure`), so tests drive it.

## Consequences

- 2026-07-28 clients work against mcpd without falling back, with list caching that invalidates
  through TTL and listen streams, while 2025-11-25 sessions are untouched (all earlier tests pass
  unchanged).
- New: `mcpd/modern.ts`, `mcpd/pressure.ts`; small changes in `gateway.ts` (routing and
  pruning), `instances.ts` (pressure-aware reap, `cachedDescription`, `verified`, listen streams
  get resource list changes), `jsonrpc.ts` (two standard codes), `core/config.ts` and
  `cli/commands/config.ts` (the new key).
- Tests: `test/mcpd-protocol.test.ts` (discover, lists and TTL, tool filter, relay next to a
  legacy session, dual-era initialize, header and `_meta` validation, version errors, removed
  methods, progress over SSE, cancellation by closing, MRTR gap, roots, listen streams, graceful
  close, per-PID clients and leases, helpers) and `test/mcpd-pressure.test.ts` (PSI, macOS level,
  free memory, probe choice, effective idle, reaping per level, off switch, session servers,
  failing probe, config).
- When mcpd moves to SDK v2, MRTR bridging and 2026-07-28 upstreams are the next steps.

## Sources

- Changelog of 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- Streamable HTTP (headers, validation, backward compatibility):
  https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- Versioning and the dual-era server:
  https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
- Base protocol (`_meta` keys, `resultType`, error codes):
  https://modelcontextprotocol.io/specification/2026-07-28/basic/index
- `server/discover`: https://modelcontextprotocol.io/specification/2026-07-28/server/discover
- Caching (`ttlMs`, `cacheScope`):
  https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching
- Subscriptions: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions
- TypeScript SDK: release notes of `@modelcontextprotocol/server@2.0.0` (2026-07-27, final
  2026-07-28 wire: `serverInfo` in result `_meta`, optional `clientInfo`) and the npm registry
  (v1 line ends at 1.32.2 with `LATEST_PROTOCOL_VERSION` 2025-11-25),
  https://github.com/modelcontextprotocol/typescript-sdk/releases

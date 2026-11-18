# 0046. Cross-package contracts: a versioned browser API, one call middleware, a session id in `_meta`

Date: 2026-11-17. Status: accepted. Stage 3 of the wave 7 architecture review; builds on
ADR 0019 (turno-browser is optional), ADR 0023 (tool filters), ADR 0026 (call log), ADR 0043
(the browser host) and ADR 0045 (`loadOptional`).

## Context

Three seams between turno's parts were held together by copies:

- **The CLI typed turno-browser by hand.** `cli/commands/browser.ts` and
  `browser-identity.ts` kept their own `BrowserModule` and `IdentityModule` interfaces, a copy of
  about twenty signatures of the package, with every function newer than 0.2 optional and a
  "this needs turno-browser 0.3 or later" check before each use. Nothing tied the copy to the
  package: a changed argument or result in turno-browser compiled fine and broke at run time, and
  a newer turno-browser that removed something was not detected at all.
- **mcpd checked tool calls in two places.** The 2025-11-25 path (`gateway.ts`) and the
  2026-07-28 path (`modern.ts`) each refused a tool hidden by `tools.allow` / `tools.deny` with
  the same message, and the call log lived in a third place, a hook inside
  `InstanceManager.forward` that saw every method. The next things that want to see each call
  (trimming a tool's output, local telemetry counters, a cost meter) had no home but a fourth copy.
- **A server could not tell its callers apart.** A shared, exclusive browser server sees calls
  from one agent session at a time today, but per-tab locks (one tab per agent session on one
  identity) need the server to know which session a call belongs to. mcpd knows; the server
  only sees mcpd.

## Decision

### turno-browser exports a typed API object and `API_VERSION`

`turno-browser` exports `api`, a frozen object with exactly the functions turno-cli calls
(identities, identity.json, login, doctor, reputation, bench), its type `BrowserApi`, and
`API_VERSION = { major, minor }` (1.0 now):

- `minor` goes up when a member is added; `major` when one is removed or renamed, or its
  arguments, result or meaning change. `packages/browser/test/api.test.ts` lists the members, so a
  change cannot ship without touching the list and the version.
- The CLI imports the types with `import type { API_VERSION, BrowserApi } from "turno-browser"`.
  The build erases it, so turno-browser stays out of turno-cli's `dependencies` (it is a
  devDependency of the workspace) and `turno --help` loads nothing new (`test/lazy-imports`).
- The CLI's own expectation is `BROWSER_API: typeof API_VERSION = { major: 1, minor: 0 }`: when
  the workspace package changes its version, the CLI's typecheck fails until it follows.
- `loadOptional(pkg, { api })` compares the installed package's `API_VERSION` before anything
  else. It fits when the major is the same and the minor is at least the one the CLI was built
  for. Otherwise the command fails with one line, as a `CliError` (exit 1, a JSON error under
  `--json`):
  - `turno-browser is too old for this turno (it has no API_VERSION, this turno needs 1.0 or a
    later 1.x); update it: npm install --global turno-browser@latest` (0.2 and older have none);
  - `... (its API is 1.0, this turno needs 1.2 or a later 1.x); update it: ...`;
  - `turno-browser is too new for this turno (its API is 2.0, this turno speaks 1.x); update
    turno: turno upgrade`.

  The hand-typed `BrowserModule` and `IdentityModule` are gone, and with them every per-function
  "needs 0.3" check: a package that passes the version check has every member.

### One call middleware in mcpd

`mcpd/middleware.ts` holds a `CallPipeline`. Both protocol paths send every `tools/call`
through `gateway.calls.call(client, params, originId, cancelled)`; other methods keep going to
`InstanceManager.forward` directly. A call meets, in order:

```
filter -> <opt-in stages, in order> -> calllog -> session -> InstanceManager.forward
```

- `filter`: the profile's tool filter (ADR 0023), read from the current manifest per call. A
  refused call reaches no other stage and is not logged, as before. The list filter of
  `tools/list` uses the same `toolFilterOf`.
- Opt-in stages: a `CallStage` is `{ name, run(call, next) }`; it may change `call.params` for
  the stages after it, answer without calling `next`, or change the outcome on the way back.
  None ship and none run by default; `GatewayOptions.callStages` is where one is turned on (a
  config key will turn on a real one). Tool-output trimming, local telemetry counters and a cost
  meter are the planned ones. They see the arguments as the client sent them and the outcome
  the client gets. Names are unique, lowercase (`^[a-z][a-z0-9-]*$`), and never a built-in name;
  the pipeline refuses to start otherwise. Tests register test-only stages to check the order on
  both paths.
- `calllog`: times the call and hands the event to the call log while `[mcpd] call_log` is on
  (read per call). The manager's `onCall` hook is gone; `forward` reports the variant that
  served the call through a callback instead. Records are unchanged.
- `session`: see below.

On the 2026-07-28 path the `Mcp-Param-*` header check stays before the pipeline: it is that
revision's transport validation, answered with HTTP 400. A refused tool with a header mismatch
therefore now gets the mismatch error, and the header check may read the description of a
server whose tool is then refused (it was skipped before); a conforming client never calls a
tool its list did not show.

### A client session id in `_meta`

The `session` stage puts `_meta["io.turno/session"]` on every forwarded `tools/call`: a random
UUID per client handle, kept as long as the handle lives. A handle is one 2025-11-25 session, or
one 2026-07-28 stateless client (profile, server, client PID and folder). The id is not the
`Mcp-Session-Id` and is not derived from it or from a token, so a server (remote ones too) learns
nothing it could use against mcpd; it is different for every server path of the same agent. A
value the client sent under that key is replaced; every other `_meta` key, `progressToken`
included, passes through. After an mcpd restart a rebuilt session gets a new id; the server
processes restart with mcpd anyway.

turno-browser exports the key as `SESSION_META_KEY`; mcpd's constant is typed by it
(`typeof SESSION_META_KEY`), so the two cannot drift apart. The host reads it from each call's
`_meta` (a printable string of at most 128 characters, else nothing) and hands it to turno tools
as `session` in their context. Stock tools run exactly as before, and upstream's HTTP server
(`--port`) never passes it. Per-tab locks will key on it later.

## Consequences

- A turno-browser that does not fit fails every `turno browser` and `turno identity browser:...`
  command with one message naming the command to run, instead of a TypeError or a missing
  function later. turno-browser 0.2 with this turno-cli is refused ("too old"), including the
  commands 0.2 could run; both packages release together.
- An API change in turno-browser is a typecheck failure in turno-cli until the CLI follows, and a
  test failure in turno-browser until the member list and version follow.
- A new per-call concern is one `CallStage`, not a change to both protocol paths.
- Servers behind mcpd see one more `_meta` key on tool calls. MCP lets a server ignore keys it
  does not know.
- Not done: any opt-in stage, a config key to turn one on, per-tab locks in turno-browser.

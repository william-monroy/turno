# 0043. turno-browser hosts the MCP server and uses the Playwright MCP tools as a library

Date: 2026-11-17. Status: accepted. Changes how ADR 0003 runs the tools; its tool names and
flags stay.

## Context

Since ADR 0003, `turno-browser-mcp` rewrote `process.argv` and required the Playwright MCP
program bundled in `patchright-core` 1.64.3 (`lib/entry/mcp.js`). The program then owned
everything: it parsed the flags, launched Chrome, built the tool list and answered every call.
turno never saw the browser context, the tool list or a single call, so the later stages of the
browser plan (a runtime lock with the Chrome PID, a tab cap, turno's own tools, per-session
middleware) had nowhere to live. ADR 0042 is stage 0, hygiene around that program; this is
stage 1.

Inspection of `patchright-core` 1.64.3 on 2026-11-17: the package `exports` include
`./lib/coreBundle` and `./lib/utilsBundle`, which are readable (not minified). `coreBundle`
exports a `tools` namespace with what the program is built from: `decorateMCPCommand` (the
flag definitions), `resolveCLIConfigForMCP` (file, environment and flag precedence),
`filteredTools` and `browserTools` (the tool definitions with zod schemas), `BrowserBackend`
(one session over a `BrowserContext`, `callTool(name, args, signal)`), `createBrowserWithInfo`
(every way the program gets a browser), `setupExitWatchdog`, `start` (stdio or the HTTP server),
`isProfileLocked` and `outputDir`. `createConnection(config, contextGetter)` exists too, but it
builds its own server around a fixed context and cannot relaunch one after the idle limit, so
it is not used. `utilsBundle` exports the bundled commander `program` and `z` (zod 4).

## Decision

`turno-browser-mcp` is the MCP server host (`src/host.ts`):

- **Flags.** A fresh commander `Command` (the bundled commander) gets upstream's option
  definitions from `decorateMCPCommand`, and the host replaces only the action. Help text,
  defaults, parsers and errors are upstream's; `--identity`, `--allow-http-identity`, the
  generated `--config` and `TURNO_BROWSER_IDLE` are handled before, exactly as in ADR 0019 and
  ADR 0042 (`argv.ts` is unchanged). The action does what upstream's does: exit watchdog,
  `--vision` and `tracing` compatibility, then `resolveCLIConfigForMCP`.
- **Tools.** `tools/list` is upstream's `filteredTools(config)` rendered as upstream renders it
  (`z.toJSONSchema`, the same annotations), then turno's tools, then the WebMCP tools a page
  registers. Every stock call goes to upstream's `BrowserBackend.callTool`, so the 25 tools
  behave as before; results get upstream's `mergeTextParts` and errors its `### Error` text.
- **Engine.** The browser comes from one module (`src/engine.ts`) that returns
  `{ context, pid?, close, idleTimer? }`. The `chrome` engine launches the installed Chrome
  itself, as a Patchright persistent context, with the options upstream's
  `createPersistentBrowser` uses (traces dir, launch and context options, no Playwright signal
  handlers, extensions allowed, the profile lock check and its error messages), binds it like
  upstream (`browser.bind`, so `playwright-cli` still finds it) and keeps upstream's idle rule
  (`timeouts.idle`, else one hour when headless). `pid` comes from the profile's
  `SingletonLock`. Every other mode (`--isolated`, `--cdp-endpoint`, `--endpoint`,
  `--extension`, `--shared-browser-context`, a non-Chromium browser) goes to the `upstream`
  engine, a port of the session logic of upstream's program around `createBrowserWithInfo`.
  Another engine is one more `Engine` object.
- **Sessions.** One `SessionBackend` per MCP session launches the browser on the first call that
  needs it, wraps the context in `BrowserBackend` with the engine's idle timer and a dispose
  callback, and drops it when the browser closes (idle limit, `browser_close`, a crash); the next
  call launches it again with the same profile, as before.
- **Transport.** stdio, the transport mcpd and every agent use, is served by turno with the MCP
  SDK (`@modelcontextprotocol/sdk` moves to `dependencies`, the same exact version `turno-cli`
  ships). `--port` keeps upstream's `start`, with turno's session factory, so the HTTP server's
  Host check, streamable HTTP and SSE endpoints are unchanged. `initialize` reports
  `turno-browser` and its version instead of `Playwright` and `1.64.3`.
- **turno tools.** A registry (`src/tools.ts`, `TURNO_TOOLS`, empty for now) adds tools that the
  host runs itself, with the session's `BrowserContext` (launched on demand) or without a
  browser. Their input schemas use the bundled zod, so they are listed and validated like stock
  tools. A turno tool never takes the name of any upstream tool, enabled or not (ADR 0003: a
  stock name always means the stock tool); names are unique and `^[a-z][a-z0-9_]*$`. The host
  refuses to start otherwise. Tests register a test-only tool.

Nothing in the bundle is patched or overridden; the host only calls its exports.

## Consequences

- `test/upstream-contract.test.ts` now also pins the library: the arity of each export used,
  the `BrowserBackend` methods and how it uses the idle timer and dispose callback, that a
  decorated command's action can be replaced, the source of `createPersistentBrowser`,
  `createBrowser`, `createBrowserWithInfo`, the program's action and the server that the host
  copies, and that the host's whole `tools/list` (names, descriptions, input schemas,
  annotations, with and without `--caps`) equals the stock program's. `--port` is checked end
  to end over streamable HTTP.
- `test/host.test.ts` covers the registry, routing, launch on demand and engine selection with a
  fake engine; `test/chrome-lifecycle.test.ts` adds a navigate and snapshot through the built
  server on real Chrome, and a test-only turno tool reading the same context the stock tools
  drive. The lifecycle tests of ADR 0042 pass unchanged: the sweep, the shutdown guard and the
  exit watchdog still see a Chrome whose parent is this process.
- An upgrade of `patchright-core` is a review of those tests; the version stays pinned exactly.
  If a stock tool ever could not run through `BrowserBackend`, the answer is to stop and record
  why, not to patch the bundle.
- The install grows by the MCP SDK and its dependencies for users who install `turno-browser`
  alone (the same packages `turno-cli` already installs); the published shrinkwrap covers them.
- Next stages (identity and lifecycle module, runtime lock with `{nodePid, chromePid, pgid}`,
  per-session middleware) build on the engine's `pid` and the host's view of each call.

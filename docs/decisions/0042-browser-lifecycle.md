# 0042. Browser lifecycle: idle Chrome closes, orphans are swept, shutdown has a deadline

Date: 2026-11-17. Status: accepted.

## Context

A Chrome that `turno-browser-mcp` left open for hours took most of the RAM of a 16 GB Mac. The
wrapper hands control to the Playwright MCP program bundled in `patchright-core` 1.64.3 and only
adds `--browser chrome` and `--user-data-dir` (ADR 0005), so the browser's whole lifecycle was
upstream's:

- **No idle limit when headed.** `--idle-timeout` defaults to one hour for headless browsers
  and to never for headed ones (`createBrowserWithInfo`: `config.timeouts?.idle ?? (own &&
  headless ? 1h : undefined)`), and headed is turno's default. Tabs and popups are never closed,
  and Playwright's switches keep background tabs running at full speed.
- **A Chrome can outlive its server.** The MCP SDK closes a stdio server by closing stdin,
  then SIGTERM after 2 seconds, then SIGKILL after 2 more. Upstream's exit watchdog allows
  itself 15 seconds to close the browser, and Playwright starts Chrome as the leader of its own
  process group and kills that group only from exit handlers, which never run after SIGKILL.
  In practice Chrome notices its `--remote-debugging-pipe` closing and quits (measured with
  Chrome 157 on macOS, headed and headless), but a Chrome that does not answer in time (a
  frozen page, a slow profile write) is left running under launchd, holding the profile's
  `SingletonLock`, so the next start fails with "Browser is already in use".
- **Contradictory advice.** `docs/mcp.md` recommended `scope = "session"` for servers that
  drive a browser, while `turno identity add` prints `scope = "shared"`, `exclusive = true`,
  `idle = "30m"`. mcpd never stops a session server whose launcher lives, not on idle and not
  under memory pressure (ADR 0028), so the documented choice was the worst one for memory.

This is stage 0 of the browser plan: hygiene inside the current wrapper. Serving MCP from
turno itself (stage 1) comes later.

## Decision

### A generated config closes an idle Chrome, headed included

`buildArgv` adds `--config <file>` with `{"timeouts": {"idle": <ms>}}`. The file is written
before the program starts, mode 600: `<state>/browser/identities/<id>/mcp-config.json` for an
identity (outside the Chrome profile), next to the temporary profile otherwise. Upstream honors
`timeouts.idle` whatever the headless setting, closes the browser after that long without a
tool call, and opens it again with the same profile on the next call; the server process stays.

- Default 15 minutes, `TURNO_BROWSER_IDLE` (`"10m"`, `"90s"`, `"0"` for never) changes it,
  for example in the server's `env` in `mcp.toml`.
- Upstream precedence is file, then environment, then command line, so `--idle-timeout <ms>`
  and `PLAYWRIGHT_MCP_IDLE_TIMEOUT` still win. A `--config` of the user's own (or
  `PLAYWRIGHT_MCP_CONFIG`) replaces turno's file entirely: copying it elsewhere would break its
  relative paths.
- Nothing is generated for a browser the program does not launch (`--cdp-endpoint`,
  `--endpoint`, `--extension`). Flags and tool names are unchanged.

### One recommendation for scope and idle

A browser identity is a `shared` server with `exclusive = true`, `lease = "10m"` and
`idle = "30m"`, the block `turno identity add` prints. Chrome closes after 15 minutes without a
call inside the server; mcpd stops the server after 30, sooner under memory pressure. `session`
stays the scope for per-conversation state, such as a throwaway browser without an identity.
`docs/mcp.md`, the README and the package README now say the same.

mcpd also changes: under **critical** memory pressure a quiet session server stops like any
other once it has been idle for the critical cap (`idle_under_pressure / 4`), even while its
launcher lives; the next call starts it again. Under `normal` and `warn` a session server whose
launcher lives is still kept. Critical pressure means macOS is about to compress, swap or kill
processes, and a browser that has sat idle for over a minute is the cheapest thing to give
back; its profile is on disk, only the open tabs are lost. In-flight calls still keep any
instance.

### Orphans are swept on start

Before the program starts, `turno-browser-mcp` reads the PID in the profile's `SingletonLock`.
It acts only when every check passes:

1. the PID (or its process group) is alive;
2. `ps` shows a Chrome browser process (no `--type=`) whose command line passes exactly this
   profile as `--user-data-dir=<dir>` (a reused PID or another profile never matches);
3. its parent is gone: init, launchd or a `systemd --user` subreaper, or no process at all. A
   Chrome that a live process drives (another session, `turno identity login`) is left alone
   and upstream reports the profile as in use, as before.

Then it sends SIGTERM to the browser process alone, so it shuts down its helpers and writes the
profile (a SIGTERM to the whole group would also kill the network process that holds the cookie
store), waits up to 3 seconds, and sends SIGKILL to the whole group, which it signals only when
the browser process leads it. Helpers left in the group after the browser process died are
found by group id and the same profile flag. The server notes the sweep on stderr (mcpd's log
for the server).

### Shutdown has a deadline

On stdin close, SIGTERM or SIGINT the program closes the browser gracefully, as before. If
Chrome is still running 1.5 seconds later, it gets SIGTERM; 1 second after that the server
exits, and an exit handler sends SIGKILL to the group of the Chrome this process started (its
parent PID is the server's, checked through `ps`). All of it fits in the 4 seconds the SDK
allows. SIGHUP, which used to kill the server without any cleanup, is turned into SIGTERM.

### `turno mcp top` counts the group

`ps` now reports the process group too, and a descendant that leads its own group brings every
member of the group into the server's memory, so a Chrome helper whose parent went away still
counts. procfs hosts without `ps` keep the parent-only sum.

## Consequences

- Real Chrome tests (`packages/browser/test/chrome-lifecycle.test.ts`) cover the idle limit
  while headed on macOS (headless elsewhere), the shutdown deadline with a frozen Chrome, a
  server killed with SIGKILL, and the sweep of a real orphan. They skip, with the reason in the
  suite name, when Chrome is missing or cannot start, or with `TURNO_SKIP_CHROME=1`. Every
  Chrome they start lives on a profile in the test's sandbox HOME, and cleanup signals only
  processes whose command line names that sandbox.
- `test/upstream-contract.test.ts` pins patchright-core 1.64.3, the exact list of 25 tools,
  the config key and its precedence (through upstream's own `resolveCLIConfigForMCP`), the
  idle timer and the exit watchdog. An upgrade that changes any of them fails there.
- The server process (Node only) stays after Chrome closes for idle; mcpd stops it after its
  own `idle`. Outside mcpd (a plugin, a direct `.mcp.json` entry) Chrome now closes
  after 15 minutes too, which it never did before.
- Not done here: a tab cap, closing popups, removing the anti-throttling switches, a runtime
  lock with the Chrome PID, and a stop grace per server in mcpd. Those belong to the later
  stages, when turno-browser serves MCP itself.

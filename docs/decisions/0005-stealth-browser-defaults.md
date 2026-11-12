# 0005. Stealth defaults for claudio-browser-mcp

Date: 2026-11-12. Status: accepted.

## Context

ADR 0003 runs the Playwright MCP program shipped in `patchright-core@1.64.3`
(`lib/entry/mcp.js`). A spike on 2026-11-12 (macOS, system Google Chrome 157) checked what that
program does by default and what we must add:

- `node lib/entry/mcp.js --help` prints the Playwright MCP flags (`--browser`, `--headless`,
  `--user-data-dir`, `--isolated`, `--viewport-size`, `--init-script`, ...). An MCP SDK 1.32.2
  stdio client lists 25 tools (`browser_navigate`, `browser_snapshot`, `browser_click`,
  `browser_console_messages`, ...) in about 0.3 s. Listing tools does not launch a browser.
- Without `--browser`, the program already picks the `chrome` channel. It always adds
  `--disable-blink-features=AutomationControlled` and drops `--disable-extensions`.
- Headed runs get `viewport: null` (the window size is the viewport). Headless runs get a fixed
  1280x720 viewport; there is no CLI flag for `null` (only a `--config` file).
- Without `--user-data-dir`, the profile is `~/Library/Caches/ms-playwright-mcp/mcp-chrome-<hash
  of cwd>`: persistent and shared by every server started in the same folder, so neither isolated
  nor per identity. A second server on a locked profile fails with "Browser is already in use".
- `browser_console_messages` works for browser-level entries (CSP violations, interventions) but
  returns nothing for the page's own `console.log`/`console.error`, because Patchright disables
  the Console API to avoid detection.
- Headless navigation to `https://bot-detector.rebrowser.net/` through the MCP: green for
  `runtimeEnableLeak`, `navigatorWebdriver`, `pwInitScripts`, `cdpBindingGlobals`,
  `nativeTampering`, `workerConsistency` and the rest; red for `headless` (`HeadlessChrome` in
  the user agent) and `storagePartitioning` (Playwright launches Chrome with
  `--disable-features=...ThirdPartyStoragePartitioning...`); yellow for `viewport` (1280x720).
  With `viewport: null` (library launch, as the bench does) the viewport test turns green.
  `https://bot.sannysoft.com/` headless: 3 failed rows of 31 (user agent, `HEADCHR_UA`,
  `CHR_MEMORY`).

## Decision

`claudio-browser-mcp [--identity <id>] [flags]` passes every flag through and adds only what the
user did not set:

- `--browser chrome`: the installed Google Chrome, never a downloaded Chromium.
- `--user-data-dir <data>/browser/identities/<id>` with `--identity`, otherwise a fresh
  `mkdtemp` profile that is deleted when the process exits. `--identity` cannot be combined with
  `--user-data-dir`, `--isolated` or an external browser (`--cdp-endpoint`, `--endpoint`,
  `--extension`), which also skip both defaults.
- Headed (the program's default, so `viewport: null`). No `--headless`, no `--viewport-size`.
- No init scripts: `window.__pwInitScripts` and script injection are what detectors look for.
- `--output-dir` is left to the program, so snapshots land in the client's workspace root as
  with stock Playwright MCP and relative links keep working.

`claudio browser login <id>` and the bench launch the same way through the library
(`launchPersistentContext`, `channel: "chrome"`, `viewport: null`).

## Consequences

- Headed is the stealthy mode; headless is detectable by user agent alone, so it is opt-in
  (`--headless`) and best kept for sites without bot checks.
- Storage partitioning stays off (an upstream Playwright default) and remains detectable by the
  rebrowser test. Fixing it needs a config file with `ignoreDefaultArgs`; not worth it yet.
- Pages' own console output is invisible to agents; `browser_evaluate` is the workaround.
- One Chrome per identity: mcpd's `exclusive` lease and Chrome's profile lock both enforce it,
  and `claudio browser login` refuses while the profile is locked.
- `claudio browser bench` measures these claims again whenever Chrome or Patchright changes.

# turno-browser

## 0.3.0

### Minor Changes

- e806948: `browser_batch`, useful action errors and the settle setting:
  
  - New tool `browser_batch`: runs up to 20 stock browser actions in order in one call, checks
    every action's arguments before running any, stops at the first failure, and returns one line
    per action and one snapshot at the end only when `snapshot` is true.
  - A `browser_click`, `browser_hover`, `browser_type`, `browser_select_option` or `browser_drag`
    that times out because of the element now says which element covers the target (role, name,
    a short selector and its buttons), or that the target is hidden (and by what), disabled,
    read-only or gone, and suggests the next step. Tool names and schemas are unchanged.
  - identity.json `settle` (like `"100ms"`) sets the wait after each action, Playwright's 500 ms
    by default; `--timeout-settle` still wins. In a local benchmark of 8 calls it cut the wall
    time of a form fill from about 1.8 s to 0.6 s.
- cc6b5b2: Browser identity module:
  
  - `identity.json` next to each identity's profile keeps its time zone, languages, locale and
    region fixed; Chrome gets them at every start (`--accept-lang`, `--lang`, and the time zone
    when it differs from the machine's). `turno identity add browser:<id>` pins a new identity to
    the current time zone and takes `--timezone`, `--locale`, `--languages`, `--region` and a
    health check; `turno identity show` and `turno identity set` read and change it
    (`turno browser show/set <id>` too). Without the file nothing changes.
  - A runtime lock (`{ nodePid, chromePid, pgid, startedAt }`) while an identity's Chrome runs: a
    second session gets a message naming the process and how to stop it instead of "Browser is
    already in use".
  - An optional session health check (a URL and a text or selector) marks a signed-out identity
    NEEDS_AUTH; tool calls then fail with a message that asks for `turno browser login <id>`.
  - Each captcha, "verify it's you" or block page an identity meets is logged per site (host name
    only); `turno browser reputation [<id>] [--json]` shows counts and trend.
  - `turno browser doctor [--fix] [--no-launch] [--json]`: Chrome and its version, a smoke launch,
    the desktop session, and per identity its settings, lock, sign-in and recent challenges, with
    a fix for each problem.
  - mcpd: `stop_grace` per server in `mcp.toml`, the wait between closing stdin and SIGTERM;
    5 seconds by default for turno-browser-mcp, the SDK's 2 seconds for every other server.
- 7779c38: Opt-in resource blocking and resource cache per identity, both off by default:
  
  - identity.json `block`: `trackers` (a built-in list of ad and analytics hosts), `types`
    (`image`, `media`, `font`) and `patterns` (host names or URL globs). The page itself is never
    blocked.
  - identity.json `cache`: keeps images, fonts, stylesheets and scripts on disk for that identity
    only (`maxSize`, default 100MB, least recently used first), following `Cache-Control`, never
    storing a response with `Set-Cookie` or a request with `Authorization`. Misses still go out
    through Chrome; hits are served from disk.
- 59309b5: `turno browser export <id> --out <file>` and `turno browser import <file> [--as <id>]` move an
  identity's cookies, localStorage and IndexedDB as one file encrypted with a passphrase (scrypt
  and AES-256-GCM), refused after its expiry and never holding vault credentials.
  `"keychain": "system"` in identity.json makes Chrome encrypt an identity's cookies with the OS
  keychain instead of Playwright's fixed mock key; the default is unchanged.
  turno-browser's API is now 1.2, which this turno requires.
- 85d9bff: Tab governor:
  
  - At most 8 pages stay open per session's browser; past that the least recently used one
    closes (never the agent's current tab). Popups that open while no tool call runs, such as a
    pop-under a page opens seconds after a click, are closed; a window the agent's own click opened
    stays.
  - A page unused for 5 minutes is parked on about:blank and stops running; the next call that uses
    it loads its page again. After 15 minutes unused it closes. The next tool result lists what was
    closed or parked, and tab lists mark parked tabs.
  - identity.json (format 2) takes `tabs` (`max`, `popups`, `park`, `close`) and
    `backgroundThrottling`; `turno-browser-mcp` takes `--max-tabs`, `--popups`, `--park-after`,
    `--close-after` and `--background-throttling`, which win over the file.
  - Background tabs keep running at full speed by default, as before: measured, dropping
    Playwright's switches alone has no effect while focus emulation is on, and turning both off
    stalls actions on a tab that is not in front. `backgroundThrottling` turns both off and brings
    the agent's tab to the front before each call.
- 50dd77c: Credential vault for browser identities: `turno browser vault add|list|remove|submit`
  stores a username, a password and an optional TOTP secret per site in the OS secret store, and
  the new `browser_login` tool fills them into the site's sign-in page without the agent ever
  seeing them. Results and errors are redacted, values are bound to the site's origins, and the
  form is submitted only when the identity opts in. turno-browser's API is now 1.1, which this
  turno requires.
- fa324c0: Cross-package contracts:
  
  - turno-browser exports its public API as a typed `api` object with `API_VERSION` (1.0).
    turno-cli checks it when it loads the package: a turno-browser that is too old (0.2 and older
    have no `API_VERSION`) or too new stops `turno browser` and `turno identity browser:<id>`
    with one line naming what to update, instead of failing later.
  - mcpd sends every `tools/call`, from 2025-11-25 sessions and 2026-07-28 requests alike,
    through one call middleware: the profile's tool filter, then the call log, then the session id.
    Refusals and call log records are unchanged.
  - Each relayed `tools/call` carries `_meta["io.turno/session"]`, an opaque id that is stable for
    one agent session and different for every other. turno-browser-mcp hands it to its own tools
    (`session` in their context); the Playwright tools are unaffected.
- 5b46749: Browser lifecycle:
  
  - `turno-browser-mcp` passes a generated Playwright MCP `--config` that closes Chrome after 15
    minutes without a tool call, headed too; the next call opens it again with the same profile.
    `TURNO_BROWSER_IDLE` changes the limit (`"10m"`, `"0"` keeps Chrome open); `--idle-timeout`
    and a `--config` of your own still win. Flags and tool names are unchanged.
  - On start it closes a Chrome that an earlier, killed run left open on the same profile (only
    a Chrome browser process for exactly that profile whose parent is gone), and on stdin close,
    SIGTERM or SIGHUP it closes Chrome within about 2.5 seconds, forcefully if needed.
  - mcpd stops a quiet `session` server under critical memory pressure even while its session
    lives; the next call starts it again. `turno mcp top` counts the process groups a server's
    children lead, so a browser's helpers always count.
  - Docs: one recommendation for browsers, a `shared` server with `exclusive = true` per identity
    (the block `turno identity add` prints), instead of `scope = "session"`.
- 0537fc1: `turno-browser-mcp` is now the MCP server host instead of a wrapper that ran the Playwright MCP
  program bundled in `patchright-core`. It launches Chrome itself through one engine
  module, serves stdio with the MCP SDK, and runs every stock tool through upstream's tool
  backend, so the 25 tool names and input schemas, every flag, `TURNO_BROWSER_IDLE`, the idle
  close, the orphan sweep and the bounded shutdown work as before. `--port` keeps upstream's HTTP
  server. `initialize` now reports `turno-browser` and its version. A registry for turno's own
  tools is in place (no new tools yet). `@modelcontextprotocol/sdk` is now a dependency.

### Patch Changes

- 01d17db: The idle limit no longer closes Chrome in the middle of a tool call. It counted from the start of
  the last call, so a call that took longer than `TURNO_BROWSER_IDLE` (a slow page, a busy machine)
  failed with "Target page, context or browser has been closed". It now stops while a call runs and
  counts from the end of the last one.
- 2948759: The package homepage is now https://turno.wimo.dev.
- cf29953: The example time zone in the message for an invalid identity.json and in the help of
  `turno identity` is now `Europe/Madrid`.
- 5566437: Every package has a README that tells the same story as the site. turno-cli's follows the
  order of turno.wimo.dev and lists what the browser gained; turno-browser's is organized around
  what the package does (identities, the credential vault, session export and import, tab limits,
  `browser_batch`, blocking and cache, health and doctor); turno-core's says what the shared
  package is for; turno-fonts' shows the status line and how `turno ui install` uses the font.
  Each links to its page on turno.wimo.dev and to the releases.
- a0bfce8: New package `turno-core` with what turno-cli and turno-browser share: turno's paths, the secret
  store (macOS Keychain, Linux Secret Service) and the process helpers. Both packages
  now depend on it instead of keeping their own copies; behavior is unchanged.
- Updated dependencies [2948759]
- Updated dependencies [5566437]
- Updated dependencies [a0bfce8]
  - turno-core@0.1.0

## 0.2.0

### Minor Changes

- c0b33e0: Neutral engine ids for `turno browser bench`, and a README demo of the current CLI.
  
  - `turno browser bench` names its engines by browser and mode: `chrome-headed`,
    `chrome-headless`, `chrome-baseline` and `firefox`. The old ids (`patchright-chrome-headed`,
    `patchright-chrome-headless`, `playwright-stock`, `camoufox`) are still accepted by `--engine`,
    and the report (table and `--json`) uses the new ones. turno-cli keeps working with an older
    turno-browser.
  - `turno doctor` and the status screen recognize turno's own status line when its path is
    quoted (as `turno demo` writes it), and show any other status line command without quotes,
    with ~ for your home folder and cut to fit the row.
  - The README demo is recorded from `turno demo` in a throwaway HOME and shows the status screen,
    `turno init --dry-run`, profiles, the profile picker, `turno doctor` with its fix lines,
    `turno mcp list` and `turno limit show`.
- b3cfa89: A lighter default install and a locked dependency tree.
  
  - `npm install --global turno-cli` no longer pulls in `turno-browser` and `turno-fonts`
    (about 52 MB down to 27 MB). `turno ui install` downloads the status line font and checks
    each file against its pinned SHA-256. Install the browser package yourself when you want it:
    `npm install --global turno-browser`; `turno browser` and `turno identity` say so when it is
    missing, and find it in the global npm folder.
  - `turno-cli` and `turno-browser` ship an `npm-shrinkwrap.json`, so an install from npm gets
    exactly the dependency versions that were tested. No package in either tree runs an install
    script, and CI checks it.
  - `turno browser` is a developer diagnostic for browser engine compatibility. `browser bench`
    asks before it opens Chrome on third-party test pages, and without a terminal it needs
    `--yes` (`--json` alone no longer runs it). `--only-urls` replaces `--no-detectors`, which
    still works. `turno browser` and `turno identity` accept `--help` after any subcommand and
    reject unknown flags.
  - `turno-browser-mcp` refuses `--port` or `--host` together with `--identity`, which would
    serve a signed-in browser over HTTP; pass `--allow-http-identity` to accept that, and it then
    listens on 127.0.0.1 only.
  - An empty `turno identity` suggests `turno identity add ...` instead of the old
    `turno accounts add ...`.

## 0.1.1

### Patch Changes

- 35a3c4a: The README links to the `turno-cli` package, the name the CLI is published under.
- ce52d03: The repository moved to `github.com/wimo-dev/turno`. turno-browser is listed in the MCP
  Registry as `io.github.wimo-dev/turno-browser`.

## 0.1.0

First public release: an MCP server that drives your installed Google Chrome with a persistent
profile per identity (`turno-browser-mcp --identity <name>`), headed by default, plus the
`turno browser bench` checks.

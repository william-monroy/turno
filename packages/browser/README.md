# turno-browser

**A browser that is already the right you.** An MCP server that lets a coding agent drive your
own Google Chrome, with one persistent profile per identity. You sign in to a site once, by hand,
and the agent works in that same signed-in browser afterwards.

![Two accounts, each with its own Chrome profile, and a third identity an agent drives through the gateway](https://raw.githubusercontent.com/wimo-dev/turno/main/docs/assets/browser-identities.png)

```sh
npm install --global turno-browser
turno-browser add school      # a new identity, and how to connect an agent to it
turno-browser login school    # sign in by hand once; cookies persist
```

It is a separate package from [turno](https://www.npmjs.com/package/turno-cli), not installed
with it; turno works without it. The `turno-browser` command manages identities on its own; with
turno installed, `turno browser <command>` and `turno identity ... browser:<id>` run the same
commands and add what turno has, like the `mcp.toml` block and `turno browser do` through mcpd. The whole story is at [turno.wimo.dev](https://turno.wimo.dev).

## Why

- **Your agent opens a browser that is not signed in.** Here each identity is a real Chrome
  profile that keeps its cookies, so the agent starts where you left off.
- **A browser left open eats the machine.** Tabs are capped, parked and closed, Chrome closes
  when nobody is using it, and it closes with the agent that started it.
- **Passwords should not pass through a model.** A vault in the OS secret store fills a sign-in
  form without the agent ever seeing the values.

## What you get

| | |
|---|---|
| [Identities](#identities) | one Chrome profile per identity, with its time zone, languages and locale fixed |
| [Credential vault](#credential-vault) | `browser_login` fills username, password and one-time code; the agent never sees them |
| [Session export and import](#move-a-session) | an identity's session as one encrypted file, for another machine |
| [Tab limits](#a-browser-that-cleans-up) | at most 8 tabs, parked after 5 minutes unused, closed after 15 |
| [`browser_batch`](#faster-actions) | up to 20 actions in one call, and errors that say what is in the way |
| [Record and replay](#record-and-replay) | save a flow once, replay it with parameters; recordings and traces, opt-in |
| [Live view and take-over](https://turno.wimo.dev/docs/concepts/browser-identities#live-view-and-take-over) | opt-in: watch the agent's tab on 127.0.0.1, pause it, act, and resume; the agent is told what changed |
| [Blocking and cache](#lighter-pages) | opt-in: block trackers, images, media or fonts; cache static resources on disk |
| [Engines](https://turno.wimo.dev/docs/concepts/browser-identities#engines) | opt-in: read mode on Lightpanda for reading pages with little memory, attach to the Chrome you have open, or Camoufox (not recommended) |
| [From the shell](https://turno.wimo.dev/docs/concepts/browser-identities#from-the-shell) | `turno browser do <id> open`, `snapshot`, `click`, `type`, `read`: the same browser and rules, as shell commands for coding agents |
| [Health and reputation](#know-when-something-is-wrong) | a signed-out identity says so, and each site's challenges are counted |
| [`turno browser doctor`](#know-when-something-is-wrong) | checks Chrome and every identity, with a fix for each problem |

It serves the Playwright MCP tools and flags (`browser_navigate`, `browser_click`,
`browser_snapshot` and the rest), run on Patchright, a Playwright fork that drives Chrome without
the automation flags Playwright adds. Defaults: headed, the installed Chrome, a persistent
profile per identity, no injected scripts. The browser a site sees is your own Chrome, signed in
by you.

## Identities

Each identity keeps, next to its profile, an `identity.json` with what should not change between
sessions: time zone, languages, locale, region, and an optional session health check.

```sh
turno identity add browser:school --languages es-ES,es,en          # pinned to this time zone
turno identity set browser:school --health-url https://mail.example.com/ --health-text Inbox
turno identity show browser:school
```

- **Applied at every Chrome start.** Languages go to Chrome's own `--accept-lang` (so the
  Accept-Language header and `navigator.languages` match), the locale to `--lang`, and the time
  zone is emulated only when it differs from the machine's. An identity made at home keeps that
  zone on a trip.
- **One Chrome per identity.** While a server drives an identity's Chrome it holds a lock; a
  second server gets a message naming that process and how to stop it, instead of "Browser is
  already in use".
- **Through the gateway.** `turno identity add` prints the `mcp.toml` block: a `shared`,
  `exclusive` server, so one session uses the identity at a time and mcpd stops it when idle.
  With `"sharing": "tabs"` (`turno identity set browser:<id> --sharing tabs`, then
  `exclusive = false`) several agent sessions use it at once, each in its own locked tabs.

## Credential vault

An identity can keep a username, a password and a TOTP secret per site in the OS secret store
(macOS Keychain, Linux Secret Service), never in a file. The `browser_login` tool fills them
into that site's sign-in page:

```sh
turno browser vault add school mail --url https://mail.example.com/login --username alice --totp
turno browser vault list school
turno browser vault submit school auto      # browser_login also submits (default: it only fills)
```

- **Bound to the site.** The tool fills only when the page is on an origin given with `--url`
  (https, or http on localhost), and only into frames of those origins.
- **Never in a result.** Once a value was filled, every result and error passes through a
  redactor: snapshots, network requests and console messages show `[vault: ...]`.
  `browser_evaluate` and `browser_run_code_unsafe` are refused on a filled page until it
  navigates, and `browser_run_code_unsafe` is refused for identities with a vault.
- **One-time codes.** TOTP follows RFC 6238 (SHA1, SHA256, SHA512, 6 to 8 digits), from a base32
  secret or the `otpauth://` URI of the QR code.

The threat model is in
[SECURITY.md](https://github.com/wimo-dev/turno/blob/main/SECURITY.md#the-credential-vault).

## Move a session

```sh
turno browser export school --out school.session --expires 2d   # asks for a passphrase twice
turno browser import school.session --as school-laptop
```

The file holds the identity's cookies, localStorage and IndexedDB, encrypted with the passphrase
(scrypt and AES-256-GCM), and is refused after its expiry (7 days by default, at most 90). It
never holds vault credentials. Importing into an existing identity replaces its session and asks
first.

`"keychain": "system"` in `identity.json` makes Chrome encrypt the profile's cookies with the OS
keychain's key instead of Playwright's fixed mock key, so a copy of the profile folder does not
hand over the sessions. Changing it signs the identity out: export first and import after.

## A browser that cleans up

| What | Default |
|---|---|
| Pages open per session's browser | at most 8; past that the least recently used closes, never the agent's current tab |
| Popups that open while no tool call runs | closed; a window the agent's own click opened stays |
| A page unused for 5 minutes | parked on `about:blank`; it loads again when the agent uses it |
| A page unused for 15 minutes | closed |
| Chrome with no tool call for 15 minutes | closed, headed too; the next call opens it with the same profile |

```sh
turno identity set browser:school --tabs-max 4 --tabs-popups keep --tabs-park 2m --tabs-close 0
```

- What was closed or parked is listed at the end of the next tool result.
- When the client closes stdin or the server gets SIGTERM, Chrome closes within about 2.5
  seconds, forcefully if it does not answer. A Chrome that an earlier, killed run left open on the
  same profile is closed when the identity starts again; one that another live process drives is
  left alone.
- `TURNO_BROWSER_IDLE` changes the idle limit (`"10m"`, `"90s"`, `"0"` keeps Chrome open);
  `--idle-timeout <ms>` or a `--config` file of your own take precedence.
- Through mcpd, stopping the server closes its stdin and waits 5 seconds before SIGTERM
  (`stop_grace`), so Chrome writes its profile on its own.

## Faster actions

- **`browser_batch`** runs up to 20 browser actions in order in one call, checks every action's
  arguments before running any, stops at the first failure and returns one line per action,
  plus one snapshot at the end when asked. A form filled in one call costs the agent one round
  trip instead of one per field.
- **Errors that help.** A click, hover, type, select or drag that times out because of the page
  says which element covers the target (a cookie banner, a dialog) with its buttons, or that the
  target is hidden, disabled, read-only or gone, and suggests the next step.
- **A shorter wait.** Playwright waits 500 ms after each action; `"settle": "100ms"` in
  `identity.json` (`turno identity set browser:school --settle 100ms`) shortens it.

## Human-like input

Off by default. `turno identity set browser:school --humanize light` (or `full`, `adaptive`; the
server's `--humanize` wins) makes the stock tools move the pointer along a curve to a point inside
the target, hold the button for tens of milliseconds and type short text key by key; `full` adds
overshoot, reading pauses and wheel scrolling, and `adaptive` uses `full` only on sites that showed
a challenge page. Schemas and results stay the same; each click costs about 0.5 s (`light`) to
1 s (`full`). See [Human-like input](https://turno.wimo.dev/docs/concepts/browser-identities#human-like-input).

## Record and replay

- **Flows.** `browser_record` saves the actions of a session as a named flow, each element kept
  four ways (Playwright's locator, role and name, text, CSS path); `browser_replay` runs it again
  with parameters and, when a step no longer fits, stops with a report the agent can continue
  from. `turno browser flows|replay <id>` does the same from a terminal.
- **No secrets in a flow.** Typed text is a parameter; a password, a one-time code or a value the
  agent marks sensitive keeps no value, and a vault sign-in is the site name only. A sensitive
  value at replay can be `keychain:<item>`, read from the secret store.
- **Recordings, opt-in.** `turno browser record <id> --flows --traces --screenshots` keeps every
  session as a flow, a Playwright trace and a screenshot per action, under a size cap (200MB);
  `turno browser traces <id> --open` shows a trace in the bundled viewer. The trace stops before
  a sign-in and starts again after the page navigates, so no vault value is ever in one.

## Lighter pages

Both are off until an identity asks for them:

```sh
turno identity set browser:school --block-trackers true --block-types image,font --cache-max-size 100MB
turno identity set browser:school --no-block --no-cache   # both off again
```

- **Blocking**: a short built-in list of ad and analytics hosts (`trackers`), resource types
  (`image`, `media`, `font`) and your own patterns (a host name or a URL with `*`). The page
  itself is never blocked.
- **Cache**: images, fonts, stylesheets and scripts on disk for that identity only, following
  `Cache-Control`, never a response with `Set-Cookie` or a request with `Authorization`.

## Know when something is wrong

- **Signed out.** With a health check (a URL and a text or selector), each Chrome start opens
  the page and looks for it. When it is missing the identity is marked NEEDS_AUTH and tool calls
  fail with a message asking for `turno browser login <id>`.
- **Reputation.** Every captcha, "verify it's you" or block page is one line in the identity's
  state folder, with the host name only (no path, no page content).
  `turno browser reputation [<id>]` shows counts per site and their trend.
- **Doctor.** `turno browser doctor [--fix] [--json]` checks Chrome and its version, a test
  launch on a temporary profile, and each identity's settings, lock and sign-in.

## Run it directly

`turno-browser --help` lists every command by section (identities, sign-ins, flows, checks), and
`turno-browser <command> --help` shows one. The MCP server itself is `turno-browser-mcp`:

```sh
turno-browser-mcp --identity school
turno-browser-mcp --identity school --max-tabs 4 --popups keep --park-after 2m --close-after 0
```

It serves over stdio. `--port` or `--host` with `--identity` would serve a signed-in browser over
HTTP, so it needs `--allow-http-identity` and then listens on 127.0.0.1 only. The server's flags
win over `identity.json`.

More: [Browser identities](https://turno.wimo.dev/docs/concepts/browser-identities),
[`turno browser`](https://turno.wimo.dev/docs/reference/cli/browser), the guide
[Let an agent use my signed-in browser](https://turno.wimo.dev/docs/guides/signed-in-browser), and
what each version added in [Releases](https://turno.wimo.dev/docs/releases).

## Acceptable use

Use it with your own accounts, on sites whose terms allow automated access by you, and at a
human pace. Do not use it to get around access controls, paywalls or rate limits, to scrape at
scale, or to access accounts that are not yours. Captcha solving is off unless you turn it on, and
then it is for your own accounts only. You are responsible for how you use it. The software is provided "as is", without warranty (Apache License 2.0).

## License

Apache-2.0. Patchright and Playwright are Apache-2.0 and install as regular npm dependencies.

# turno-browser

An MCP server that lets a coding agent drive your installed Google Chrome with a persistent
profile per identity: you sign into a site once by hand, and the agent works in that same
signed-in browser afterwards. It serves the Playwright MCP tools and flags, run on Patchright (a
Playwright fork that drives Chrome without the automation flags Playwright adds), from its own
MCP server, which launches Chrome itself
([ADR 0043](https://github.com/wimo-dev/turno/blob/main/docs/decisions/0043-browser-host-inversion.md)).

It is a separate package from [turno](https://www.npmjs.com/package/turno-cli), not installed
with it; turno works without it.

```sh
npm install --global turno-browser
turno identity add browser:school     # prints the mcp.toml entry for this identity
turno identity login browser:school   # sign in by hand once; cookies persist
```

Or run it directly as an MCP server: `turno-browser-mcp --identity school`. It serves over
stdio; `--port` or `--host` with `--identity` would serve a signed-in browser over HTTP, so it
needs `--allow-http-identity` and then listens on 127.0.0.1 only.

Defaults: headed, the installed Chrome channel, a persistent user data dir per identity, no
injected init scripts. The reasons, and what these settings do and do not change, are in
[ADR 0005](https://github.com/wimo-dev/turno/blob/main/docs/decisions/0005-stealth-browser-defaults.md).

## Lifecycle

- Chrome closes after 15 minutes without a tool call, headed too, and opens again with the same
  profile on the next call. `TURNO_BROWSER_IDLE` changes it (`"10m"`, `"90s"`, `"0"` keeps it
  open); `--idle-timeout <ms>` or a `--config` file of your own take precedence.
- A Chrome that an earlier run left open on the same profile (its server was killed) is closed
  when the identity starts again. A Chrome that another live process drives is left alone.
- When the client closes stdin or the server gets SIGTERM, Chrome is closed within about 2.5
  seconds, forcefully if it does not answer.
- Through mcpd, declare an identity as the `shared`, `exclusive` server that
  `turno identity add` prints, so mcpd stops it after `idle` and sooner under memory pressure.

- Through mcpd, stopping the server closes its stdin and waits 5 seconds before SIGTERM
  (`stop_grace`), so Chrome closes and writes its profile on its own.

Details: [ADR 0042](https://github.com/wimo-dev/turno/blob/main/docs/decisions/0042-browser-lifecycle.md).

## Identities

Each identity keeps, next to its profile, an `identity.json` with what should not change
between sessions: time zone, languages, locale, region, and an optional session health check.

```sh
turno identity add browser:school --languages es-MX,es,en          # pinned to this time zone
turno identity set browser:school --health-url https://mail.example.com/ --health-text Inbox
turno identity show browser:school
```

- **Applied at every Chrome start.** Languages go to Chrome's own `--accept-lang` (so the
  Accept-Language header and `navigator.languages` match, with Chrome's q-values), the locale to
  `--lang`, and the time zone is emulated only when it differs from the machine's. Flags of your
  own win. An identity without the file uses Chrome's defaults, as before.
- **One Chrome per identity.** While a server drives an identity's Chrome it holds a runtime
  lock (`{ nodePid, chromePid, pgid, startedAt }`); a second server gets a message naming that
  process and how to stop it, instead of "Browser is already in use".
- **NEEDS_AUTH.** With a health check, each Chrome start (at most every 30 minutes while it
  passes) opens the page and looks for the text or selector. Without it, tool calls fail with a
  message asking the user to run `turno browser login <id>`.
- **Reputation log.** Every captcha, "verify it's you" or block page is one JSON line in the
  identity's state folder, with the host name only (no path, no page content).
  `turno browser reputation [<id>]` shows counts per site and their trend.
- **Doctor.** `turno browser doctor [--fix] [--json]` checks Chrome and its version, a test
  launch on a temporary profile, and each identity's settings, lock and sign-in.

Details: [ADR 0044](https://github.com/wimo-dev/turno/blob/main/docs/decisions/0044-browser-identity-module.md).

## Credential vault

An identity can keep a username, a password and a TOTP secret per site in the OS secret store
(macOS Keychain, Linux Secret Service), never in a file. The `browser_login` tool fills them
into that site's sign-in page without the agent seeing them:

```sh
turno browser vault add school mail --url https://mail.example.com/login --username alice --totp
turno browser vault list school
turno browser vault submit school auto      # browser_login also submits (default: it only fills)
```

- **Bound to origins.** The tool fills only when the current page is on an origin given with
  `--url` (https, or http on localhost), and only into frames of those origins.
- **Never in a result.** Every result and error of the server passes through a redactor once a
  value was filled: snapshots, network requests and console messages show `[vault: ...]`.
  `browser_evaluate` and `browser_run_code_unsafe` are refused on a filled page until it
  navigates, and `browser_run_code_unsafe` is refused for identities with a vault.
- **TOTP** follows RFC 6238 (SHA1, SHA256, SHA512, 6 to 8 digits), from a base32 secret or the
  `otpauth://` URI of the QR code.

## Session export and import

```sh
turno browser export school --out school.session --expires 2d   # asks for a passphrase twice
turno browser import school.session --as school-laptop
```

The file holds the identity's cookies, localStorage and IndexedDB, encrypted with the
passphrase (scrypt and AES-256-GCM), and is refused after its expiry. It never holds vault
credentials. Importing into an existing identity replaces its session and asks first.
Details: [ADR 0055](https://github.com/wimo-dev/turno/blob/main/docs/decisions/0055-browser-session-export-import.md).

`"keychain": "system"` in identity.json makes Chrome encrypt the profile's cookies with the OS
keychain's key instead of Playwright's fixed mock key
([ADR 0059](https://github.com/wimo-dev/turno/blob/main/docs/decisions/0059-browser-cookie-keychain.md)).

Vault threat model: [SECURITY.md](https://github.com/wimo-dev/turno/blob/main/SECURITY.md#the-credential-vault).
Details: [ADR 0054](https://github.com/wimo-dev/turno/blob/main/docs/decisions/0054-browser-credential-vault.md).

## Acceptable use

Use it with your own accounts, on sites whose terms allow automated access by you, and at a
human pace. Do not use it to get around access controls, paywalls, CAPTCHAs or rate limits, to
scrape at scale, or to access accounts that are not yours. You are responsible for how you use
it. The software is provided "as is", without warranty (Apache License 2.0).

## License

Apache-2.0. Patchright and Playwright are Apache-2.0 and install as regular npm dependencies.

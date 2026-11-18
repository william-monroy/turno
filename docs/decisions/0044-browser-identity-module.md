# 0044. Browser identity module: identity.json, runtime lock, session health, doctor, reputation log, stop grace

Date: 2026-11-17. Status: accepted. Builds on ADR 0042 (lifecycle) and ADR 0043 (host).

## Context

Since ADR 0043 turno launches Chrome itself and sees every call, but an identity was still only
a Chrome profile directory. Four problems followed from that:

- **Nothing fixed the place.** Sites judge a signed-in session by its continuity: the same
  device, region, time zone and languages every time. Chrome reports whatever the machine has
  today, so an identity created at home changes time zone on a trip.
- **"Browser is already in use" said nothing.** A second session on the same identity (a direct
  `.mcp.json` entry next to mcpd's, a `turno browser login` left open) got Chrome's profile-lock
  error, with no word on who held the profile or how to stop it.
- **A signed-out session looked like a working one.** When a site dropped the login, the agent
  found out pages later, by reading a sign-in form, and often tried to sign in itself.
- **No record of challenges.** How often a site shows a captcha, asks "verify it's you" or blocks
  the identity is the honest measure of its reputation (research note 03, section 6), and nobody
  kept it.

mcpd also stopped every stdio server with the MCP SDK's fixed sequence (close stdin, 2 seconds,
SIGTERM, 2 seconds, SIGKILL). ADR 0042 squeezed the browser's shutdown into those 4 seconds by
signalling Chrome after 1.5 seconds; there was no way to give a server more time.

## Decision

### identity.json, next to the profile

`<data>/browser/identities/<id>.json`, beside the profile directory `<id>/`, never inside it:
Chrome never reads or rewrites it, and copying a profile does not copy it. Mode 600, written
through a rename, keys in a fixed order:

```json
{
  "version": 1,
  "timezone": "Europe/Madrid",
  "locale": "es-ES",
  "languages": ["es-ES", "es", "en"],
  "region": "ES",
  "health": { "url": "https://mail.example.com/", "text": "Inbox" },
  "created": "2026-11-17T16:00:00.000Z",
  "updated": "2026-11-17T16:00:00.000Z"
}
```

- Every key but the version and the dates is optional. A missing file means today's behavior:
  Chrome's own time zone and languages. `version` follows turno's
  state-file convention (ADR 0045): absent means format 1, and a newer one is refused (the file
  is reported as invalid, nothing is applied), not guessed at.
- `turno identity add browser:<id>` writes it for a new identity, pinned to the system time zone
  plus whatever flags were given (`--timezone`, `--locale`, `--languages`, `--region`,
  `--health-url` with `--health-text` or `--health-selector`). An existing identity is not given
  a file unless flags are passed. `turno identity set browser:<id>` changes it (an empty value
  removes a key, `--no-health` the check), `turno identity show browser:<id>` prints it with the
  session health and who holds the identity. `turno browser add/show/set <id>` are the same.
- The chrome engine applies it at every launch, read fresh, so `set` takes effect on the next
  Chrome start without restarting the server. Flags and context options the user set win.
  - `languages` (else `[locale, base language]`) become Chrome's own `--accept-lang`, so the
    Accept-Language header keeps Chrome's q-values and `navigator.languages` matches it.
  - `locale` becomes `--lang` (Chrome's UI, and `Intl` on Linux and Windows; on macOS Chrome
    follows the system language for `Intl`).
  - `timezone` becomes Playwright's `timezoneId`, only when it differs from the system's: there
    is nothing to emulate while the machine is where the identity lives.

  Playwright's `locale` option is deliberately not used: with Chrome 157 it collapsed the header
  to `Accept-Language: es-MX` and `navigator.languages` to one entry, which no installed Chrome
  sends (measured with Patchright 1.64.3: `locale` gives `"es-MX"`, `--accept-lang=es-MX,es,en`
  gives `"es-MX,es;q=0.9,en;q=0.8"`).
- `region` is recorded, not applied: it documents where the identity's sites know it from.
- `turno browser login` applies the same settings, so a site sees the same languages and zone at
  sign-in as later.

### Runtime lock

`<state>/browser/identities/<id>/lock.json`, mode 600:
`{ "nodePid", "chromePid", "pgid", "holder": "mcp" | "login", "startedAt" }`.

- The chrome engine takes it just before launching Chrome for an identity (O_EXCL create), adds
  Chrome's PID and process group once Chrome runs, and gives it back when that Chrome closes
  (idle limit, `browser_close`, a crash, the session ending) and in an exit handler. The same
  process may take it again (a relaunch after the idle close); a lock whose `nodePid` is gone is
  stale and is taken over. A handle never removes a lock another process or a newer handle took.
- A second holder gets, as the tool error:

  > browser identity "school" is in use by turno-browser-mcp (pid 123, Chrome pid 456) since
  > <time>. One identity drives one Chrome at a time: wait for that session to end (mcpd stops
  > the server after its lease or idle time), or stop it now with `kill 123`, which closes its
  > Chrome first.

  A login holder is told to close its window. If Chrome's profile lock is held by a process
  with no turno lock, the error says so and points at `turno browser doctor` instead of
  Playwright's generic message.
- `isInUse` and `turno browser login` read the lock first; `turno identity remove` refuses while
  it is held.

### Session health and NEEDS_AUTH

`health` in identity.json is a URL plus a text (`getByText`, visible) or a CSS selector
(attached), or both, that only a signed-in page shows, the pattern of agent-browser's
`--restore-check-text` and Kernel's health checks. When the host launches Chrome for an identity
and the check is due (no result, a failure, another URL, or a pass older than 30 minutes), it
opens a tab, loads the URL (20 s), waits for the proof (10 s), and closes the tab. The result goes
to `<state>/browser/identities/<id>/health.json`.

- Proof missing: the identity is NEEDS_AUTH. That Chrome is closed and the call fails with:

  > NEEDS_AUTH: browser identity "school" is not signed in: the page did not show "Inbox" at
  > <url> (checked <time>). Ask the user to run `turno browser login school`, sign in and close
  > the window, then call this tool again.

  For the next 60 seconds calls fail with the same message without opening Chrome, so an
  agent that retries does not open a window per call.
- The page did not load (offline, DNS): `error`, the call goes on; the next launch checks again.
- `turno browser login <id>` clears the result when its window closes; `turno browser doctor`
  shows the last one, NEEDS_AUTH as a failure with `fix: turno browser login <id>`.

### Reputation log

While an identity's Chrome runs, the host looks at every main-frame `load` of every page and
classifies it with `classifyChallenge` (`detectors.ts`): `captcha` (captcha, "verify you are
human", "just a moment", unusual traffic...), `verify` ("verify it's you", "confirm it's you",
"verify your identity") or `block` ("access denied", "attention required", "you have been
blocked"...), a block outranking a verify outranking a captcha. A phrase counts in the title, or
in the visible text of a page of at most 1500 characters, so an article that mentions a captcha
is not one. Each challenge is one line in `<state>/browser/identities/<id>/reputation.jsonl`
(mode 600): `{ ts, site, kind, markers }`, where `site` is the host name and `markers` the
matched phrases of the fixed list. No path, no query, no page content. The same site and kind
within a minute count once; the file is cut to its newer half past 1 MiB.

`turno browser reputation [<id>] [--json]` prints, per identity and site, the counts per kind,
the last 7 days against the 7 before and the trend (up, down, flat), and when it was last seen.
`turno browser doctor` warns when an identity met challenges in the last 7 days.

### `turno browser doctor [--fix] [--no-launch] [--json]`

Sections Chrome, System and Identities, one row per check, each problem with `fix:` (a command)
or `manual:`, `--json` with `status`, `fix`, `auto` and `manual` per check like `turno doctor`,
exit 1 on a failure:

- Chrome found (macOS app paths, Linux and Windows install paths) and its version (macOS reads
  `Info.plist`, so nothing starts); a smoke launch, headless on a throwaway profile under the
  temporary folder, unless `--no-launch`.
- System: on macOS, that driving Chrome through its DevTools pipe needs no Accessibility or
  Screen Recording permission (nothing to grant), and a warning in an SSH session, where a headed
  Chrome cannot open; on Linux, whether there is a display. TCC permissions themselves are not
  readable without Full Disk Access, so they are not probed.
- Per identity: identity.json (missing is fine, invalid is a failure that names the bad key and
  the `turno identity set` flag that replaces it), who holds it (runtime lock, a Chrome left
  running with no server, a Chrome no turno process explains, a stale lock), the session health,
  and recent challenges.

`--fix` removes runtime locks whose process is gone and stops a Chrome left running on an
identity's profile with no server (`sweepOrphan`, the same checks as a server start, ADR 0042).
It never touches a Chrome that a live process drives.

### `stop_grace` per server in mcpd

`stop_grace = "5s"` in a stdio server's `mcp.toml` block (a duration, at most 60 s): how long
mcpd waits after closing the server's stdin before SIGTERM. Then, as before, 2 seconds and
SIGKILL. Unset, it is 5 seconds for any server whose command or an argument is
`turno-browser-mcp` (a path or `npx -p turno-browser turno-browser-mcp` included) and the SDK's
2 seconds for everything else, whose stop is unchanged. 5 seconds fits ADR 0042's shutdown
(graceful close, Chrome gets SIGTERM after 1.5 s, the server exits 1 s later) with room for the
process to exit, so the server is never signalled in the middle of writing the profile. The
block `turno identity add` prints is unchanged: the default covers it, and an older turno-cli
would not know the key.

mcpd wraps the SDK transport's `close` and reads its child process, a private field of the
pinned SDK; if that field ever goes away the SDK's own close runs unchanged.

### Fit with the output contract (ADR 0045)

- `turno browser show`, `doctor` and `reputation` (and `turno identity show browser:<id>`) print
  JSON through `emit`: `schemaVersion` on the object (on each identity of `reputation`, a list),
  `--json=fields` and `--json=a,b`. `doctor --json` has the shape of `turno doctor --json`
  (`ok`, `counts`, `checks` with `status`, `fix`, `auto`, `manual`, and `fixed`) and exits with
  `Exit.failure` on a failed check.
- identity.json and lock.json follow the state-file rules of `core/state-file.ts`: a top-level
  `version` (absent is format 1, a newer one is refused), a guard for the shape, and a missing
  file as the normal case. turno-browser does not depend on turno-cli, so it has its own small
  readers with those rules instead of importing `readState`; the CLI never reads these files
  itself, it asks the package. A lock that is not valid JSON or not a lock counts as stale.
- turno-browser is loaded through `loadOptional` (the `turno browser` loader), and the CLI types
  the new functions as optional: an older package gets "this needs turno-browser 0.3 or later".
- No new `TURNO_*` variable.

## Consequences

- New files per identity: `<id>.json` next to the profile; `lock.json`, `health.json` and
  `reputation.jsonl` in the state folder next to `mcp-config.json`. `turno identity remove` deletes
  all of them with the profile.
- The CLI types the module locally (ADR 0019): with turno-browser 0.2 the new commands say
  "this needs turno-browser 0.3 or later", and `add` with settings flags refuses.
- Tests: unit tests for each module (settings, lock, health, reputation, doctor, the host's
  NEEDS_AUTH path with a fake engine, the CLI with the workspace package); real Chrome tests for
  the applied languages and time zone, the lock and its message to a second server, the lock's
  release on the idle close, NEEDS_AUTH and its recovery, a challenge page in the log with no
  path or query, and the doctor's smoke launch; an mcpd test for `stop_grace` with a server that
  takes 2.6 seconds to stop.
- The health check costs one page load per launch at most every 30 minutes while it passes,
  and a tab that flashes in a headed Chrome.
- Not done: deriving time zone and languages from a proxy's IP (turno uses no proxies), an
  encrypted export of an identity, a tab per agent on one identity, and `turno status` showing
  NEEDS_AUTH.

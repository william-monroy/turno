---
"turno-browser": minor
"turno-cli": minor
---

Follow-ups for browser identities.

A tool call no longer starts while the tab governor is still closing a popup or a parked tab, so
the call cannot fail with "Target page, context or browser has been closed". A Chrome that does
not stop after SIGKILL gets 5 seconds instead of 2 before turno calls it a survivor.

A server in read mode stops a Lightpanda that a killed server left running on the same cookie jar
when it starts, and removes its socket folder.

`turno browser doctor` warns when an identity that serves one session at a time
(`"sharing": "session"`) is served by an mcp.toml server with `exclusive = false`, and says how to
switch it to `"sharing": "tabs"`.

The tab lock wait (10 seconds) and the idle release (5 minutes) of `"sharing": "tabs"` can be set
per identity: `"tabLocks": { "wait": "30s", "release": "10m" }` in identity.json, or
`turno browser set <id> --tab-lock-wait 30s --tab-lock-release 10m`. identity.json is now format
9 and the turno-browser API is 1.8.

The `light` humanize level moves the pointer on a visible arc (some 4 to 8% longer than the
straight line) instead of an almost straight path. With humanize on, `browser_login` clicks into
each field and types the value key by key; the keys go to Chrome only, never to a result, a
recording or a log.

When another element covers the target of a click, hover, type, select or drag before the call,
and still covers it 300 ms later, the error names that element at once instead of after the 5
second action timeout.

Chrome keeps its third-party storage partitioning on, as a person's Chrome does: Playwright turns
it off, and turno now passes Playwright's list of disabled features without it.

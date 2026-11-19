---
"turno-browser": minor
"turno-cli": minor
---

Two opt-in engines for browser identities and servers, both off by default.

Read mode runs an identity (or one server) on Lightpanda instead of Chrome, for reading pages
with a fraction of the memory: `turno browser set <id> --engine lightpanda`, or
`turno-browser-mcp --engine lightpanda`. turno never downloads Lightpanda; it runs the
`lightpanda` on your PATH (or at `TURNO_LIGHTPANDA_PATH`), on a private Unix socket with
Lightpanda's telemetry off. The tools that work there run; the others (screenshots, dialogs,
drag and drop, uploads, `browser_login`) are refused with the reason before they reach the
browser. An identity in read mode keeps its own cookie jar, apart from its Chrome profile.

Attach mode connects to the Chrome you already have open, so the agent works in your signed-in
browser: `turno browser set <id> --attach auto` (after you turn on remote debugging at
chrome://inspect/#remote-debugging, Chrome 144 or newer), a Chrome user data folder, or a
loopback endpoint; `turno-browser-mcp --attach <target>` for one server. Chrome asks you to allow
each connection. turno works in a tab of its own, closes only the tabs it opened (on
`browser_close`, at the end of the session and at the idle limit) and never closes Chrome; the
tab governor leaves your tabs alone, and `browser_run_code_unsafe` is refused.

`turno browser doctor` gains an Engines section (Lightpanda found or how to install it, a
Lightpanda left running, which `--fix` stops) and checks each identity's attach target without
connecting. identity.json is now format 6 (`engine`, `attach`), and the turno-browser API is 1.5.

Read mode works with `"sharing": "tabs"`. Two pairs are refused with the reason, in identity.json
and from server flags: attach mode with `"sharing": "tabs"` (turno keeps one agent's tabs apart
from yours in your Chrome, not several sessions apart), and read mode with `humanize` (Lightpanda
lays out no page, so there is no pointer path to play). Attach mode works with `humanize`.

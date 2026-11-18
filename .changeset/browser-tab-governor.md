---
"turno-browser": minor
---

Tab governor (ADR 0048):

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

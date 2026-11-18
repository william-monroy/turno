# 0051. browser_batch, action errors that say what is in the way, and settle

Date: 2026-11-18. Status: accepted. Builds on ADR 0043 (host and turno tool registry) and
ADR 0048 (tab governor).

## Context

Research note 07 and the report on turno browser found three costs in how an agent drives a page
through Playwright MCP:

- **Round trips.** Filling a form is one tool call per field, each a full model turn.
- **Errors that do not help.** A click on a button under a cookie banner waits out the action
  timeout and returns `Timeout 5000ms exceeded` with a call log. The agent retries, takes a
  screenshot, or gives up; the reason (the banner, and its "Accept" button) is one
  `elementFromPoint` away.
- **A fixed wait.** After each action upstream waits `timeouts.settle` (500 ms) for the work the
  action started, then for a triggered navigation or the triggered requests. On most actions the
  500 ms is most of the call.

## Decision

### `browser_batch`

A turno tool (registered through `TURNO_TOOLS`, listed after the stock tools, never with a stock
name; ADR 0043):

```json
{ "actions": [{ "tool": "browser_type", "arguments": { "target": "e3", "text": "Alice" } },
              { "tool": "browser_click", "arguments": { "target": "e7" } }],
  "snapshot": true }
```

- 1 to 20 actions, each a stock tool of this session with its own arguments. Every action is
  checked against that tool's schema before any runs, so a typo in the last one runs nothing.
  A batch cannot hold a batch.
- Each action runs through the same path as a call of its own (tab governor, the errors below),
  with the session's `snapshot.mode` set to `"none"` for that call, so upstream skips the
  accessibility snapshot and the WebMCP refresh it would add to an action's result.
- It stops at the first failure: the result starts with the error of that action and says how
  many did not run. Otherwise one line per action (with a short `Result` or dialog line when the
  action had one), the page URL and title, and one `browser_snapshot` at the end only when
  `snapshot` is true.
- The host hands a turno tool a `stock` handle (`StockAccess`: the stock schemas, a call, the
  current page) for this; the tool never reaches upstream itself.

Refs come from the snapshot before the batch, so a batch suits actions on one page (a form) or
selectors; the tool description says so.

### Action errors (`src/diagnose.ts`)

The host wraps the stock call. When `browser_click`, `browser_hover`, `browser_type`,
`browser_select_option` or `browser_drag` fails with an actionability failure (a timeout,
"intercepts pointer events", "not visible/enabled/editable/stable"), it evaluates one function on
the target (the snapshot ref through `page.getByRef`, or the selector) and rewrites the error:

```text
### Error
Could not click button "Save" (button#save), e7: dialog "We use cookies" (div.cookie-banner) covers it and would get the click instead.
Next: close or answer that element first (it has "Accept all", "Reject"), then try again; take a new snapshot if the page changed.
Playwright: TimeoutError: browserBackend.callTool: Timeout 5000ms exceeded.
```

- Covered: scroll the target into view, take `elementFromPoint` at its center (through shadow
  roots), and name the outermost ancestor of the hit element that does not hold the target, with
  up to 3 of its buttons.
- Hidden (with the ancestor that hides it), disabled (including `aria-disabled` and a disabled
  fieldset), read-only, gone (the ref no longer resolves), or "fine now" (it was moving or
  covered for a moment: try once more).
- Role and name follow the element's ARIA role or its tag, and its label, `aria-label`, text or
  `alt`; the selector is `tag#id`, a test id or name attribute, or `tag.class`.
- The first line of Playwright's error stays. A stale ref ("not found in the current page
  snapshot") and every other error are left as upstream wrote them. JSON results keep their
  shape (`{ isError, error }`). A call that succeeds costs nothing; the look takes at most 1 s.

Tool names, schemas and successful results are unchanged.

### `settle`

identity.json format 2 takes `settle`, a duration from `"0"` to `"10s"`. The host gives each
launch its own copy of the config (so a batch's `"none"` snapshot mode and the settle reach only
that session) with `timeouts.settle` set from it, unless the user set Playwright's own
`--timeout-settle`, `PLAYWRIGHT_MCP_TIMEOUT_SETTLE` or `timeouts.settle` in a config file, which
win. The rest of upstream's wait (for a triggered navigation's `load`, or for triggered requests,
5 s at most) is unchanged: `"0"` keeps it, so an action that fetches still waits for the fetch.
The default stays 500 ms, since a page that reacts on a timer after a click would otherwise be
read before it changed.

### Measured

`bench/browser-roundtrips.mjs`: a form fill on a local page with 300 more links and buttons
(navigate, type twice, select, check, submit with a fetch, wait for the result text, snapshot),
headless Chrome 157, macOS M3, median of 5 runs. CDP commands counted from `DEBUG=pw:protocol`.

| Build and mode | Wall time | CDP commands | MCP calls | Result bytes |
|---|---|---|---|---|
| main, one call per action | 1782 ms | 141 | 8 | 23669 |
| this change, one call per action | 1835 ms | 141 | 8 | 23669 |
| this change, `settle: "100ms"` | 596 ms | 141 | 8 | 23669 |
| this change, `browser_batch` | 1701 ms | 131 | 1 | 22585 |
| this change, `browser_batch` and `settle: "100ms"` | 488 ms | 131 | 1 | 22585 |

The settle is most of the wall time. The batch saves 7 model round trips (which the benchmark
cannot time: each is a model turn) and 10 CDP commands (5 snapshots skipped). Upstream already
sends no snapshot for most of these actions and only a small one for the rest, so the result
bytes barely change; most CDP commands are the actions themselves (`Runtime.callFunctionOn` to
resolve and act on locators).

## Consequences

- An agent fills a form in one call and learns why a click failed from the error.
- The cover check names what `elementFromPoint` returns; a page that lets clicks through a
  transparent overlay (`pointer-events: none`) is reported by Playwright, not here.
- `snapshot.mode` and `timeouts.settle` are read from the config on every call; the contract test
  pins both reads, the error format and `getByRef`, so an upstream change fails the test, not a
  session.
- Not done: a settle per tool call (the batch could take one), and `turno identity set --settle`.

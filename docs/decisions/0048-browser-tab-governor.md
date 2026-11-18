# 0048. Browser tab governor, and background throttling stays off by default

Date: 2026-11-18. Status: accepted. Builds on ADR 0042 (lifecycle), ADR 0043 (host) and
ADR 0044 (identity module).

## Context

ADR 0042 closes an idle Chrome, but while an agent works nothing limits what that Chrome keeps
open. Every page an agent or a site opens stays until somebody closes it, and keeps running
scripts, timers and network: an ad popup, a tab the agent looked at an hour ago, a pop-under a
download button opened. Research note 02 found the same pattern in other browser servers (a
forgotten single-page app at 28 to 30 % CPU for hours in chrome-devtools-mcp #2599, 60 and more
accumulated tabs heating MacBooks in agent-browser #885) and no project with a tab cap.

Playwright also launches Chromium with three switches that keep background pages at full speed
(`--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`,
`--disable-renderer-backgrounding`), and ADR 0042 left open whether turno should stop passing
them.

## Decision

### The tab governor

The host runs one governor per session's browser context (`src/governor.ts`) and wraps every
stock tool call with it:

- **Cap.** At most `max` pages are open at once (default 8). When a new page goes past it, the
  least recently used page closes: never the agent's current tab, never the new page.
- **Popups.** A page with an opener that opens while no tool call is running, and not within
  2 seconds of the end of one, is closed (`popups: "close"`, the default; `"keep"` leaves it).
  Chrome's popup blocker already stops `window.open` without a user gesture; what gets through
  is a window a page opens later on the strength of a click (the click's user activation lasts
  5 seconds), the usual pop-under. A window the agent's own call opened (a `target="_blank"`
  link, a sign-in popup) is the agent's and stays. Pages without an opener (`browser_tabs new`,
  a tab a person opened) are never treated as popups.
- **Parking, in two stages.** A page unused for `park` (default 5 minutes) is navigated to
  about:blank, which stops its scripts, and its URL is kept. The next call that uses it (it is
  the current tab, or `browser_tabs` selects it) loads that URL again first. A page unused for
  `close` (default 15 minutes) closes. A page counts as used when it is the current tab at the
  end of a tool call, or when its main frame navigates (a person in a headed window). The
  current tab is never parked or closed, nor is the last page, and nothing is swept while a call
  runs. Reloading a parked page loses what was typed into it; that is the price of a page that
  stopped running.
- **Telling the agent.** What the governor did since the last call is listed in a last section
  of the next stock result (`### Tab governor`, or `turno.tabs` in JSON), and a parked tab is
  marked in tab lists: `- 1: [](about:blank) (parked, was <url>: selecting it loads that page
  again)`.

The governor reads upstream's tabs from `BrowserBackend._context` (`tabs()`, `currentTab()`,
`tab.page`), which the contract test pins along with the rest of the library surface. Nothing in
the bundle is patched.

### Settings

identity.json gets two keys, which make the file format 2 (a file without them stays format 1,
so an older turno-browser keeps reading it; one with them is refused by an older one with
"update turno-browser" instead of being misread):

```json
{
  "version": 2,
  "tabs": { "max": 8, "popups": "close", "park": "5m", "close": "15m" },
  "backgroundThrottling": false
}
```

`turno-browser-mcp` flags win over the file, and work without an identity too: `--max-tabs <n>`
(0: no cap), `--popups <close|keep>`, `--park-after <duration>`, `--close-after <duration>`
(`"0"` turns a stage off) and `--background-throttling`. They are taken out of the arguments
before upstream parses them, like `--identity`, and the contract test checks that upstream has
no option of the same name. identity.json is read at every launch, like the rest of it.

### Background throttling: measured, kept off by default, opt-in

Measured on macOS with Chrome 157 and patchright-core 1.64.3, headed and headless: a page in a
background tab running a 4 ms timer loop and an animation-frame loop, the agent's page in front.

| Launch | Background timer ticks/s | Background frames/s | `visibilityState` |
|---|---|---|---|
| Playwright's switches (today) | about 210 | 120 headed, 60 headless | visible |
| Switches dropped | about 200 | 120 headed, 52 headless | visible |
| Switches dropped and `focusControl` | 1 | 0 | hidden |

Dropping the switches alone changes nothing: Playwright turns on focus emulation for every page
(`Emulation.setFocusEmulationEnabled`), so each page reports itself visible and focused and
runs at full speed. Only with focus emulation off too (the `focusControl` context option) does
Chrome throttle background tabs. But then a tab that is not in front cannot be acted on: a
`click` on it waited its whole 5 second timeout (no animation frame, so never "stable"), and a
500 ms settle took over a second. In a headed window the same happens to the agent's own tab
when another window covers Chrome, since the occluded-window switch is gone too.

So the default stays as Playwright launches it, and parking is what stops forgotten pages. The
switch is there for whoever wants it (`backgroundThrottling: true` or `--background-throttling`):
it drops the three switches, sets `focusControl`, and the host brings the agent's current tab to
the front before every stock call, so the tab the agent acts on is always the visible one. With
it, the same busy background tab fell to under 20 ticks a second while actions on the current tab
kept their speed (`test/browser-tools.test.ts`). A covered headed window still pauses rendering;
it suits a headless browser or a window left in view.

## Consequences

- A long session keeps at most 8 pages and, after 5 minutes, none running in the background
  unless the agent uses them. An agent that needs more opens them with `--max-tabs`.
- A tab the agent left for 5 minutes comes back reloaded, not as it was; a form half filled in
  another tab is lost after the park time. Turn parking off with `"park": "0"`.
- Stock results can end with a `### Tab governor` section. Tool names, schemas and every other
  part of the output are unchanged.
- Tests: `test/governor.test.ts` (cap, popups, both stages, restore, a person's navigation, with
  a fake clock), `test/browser-tools.test.ts` on a real Chrome (a delayed popup closed and a
  clicked one kept, the cap, parking and reload, the close stage, background tabs at full speed
  by default and throttled with the switch while the current tab still acts at once), and pins
  in `test/upstream-contract.test.ts`.
- Not done: `turno identity set` flags for the new keys (identity.json is edited by hand or with
  the server flags for now), memory-pressure driven parking.

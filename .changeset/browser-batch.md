---
"turno-browser": minor
---

`browser_batch`, useful action errors and the settle setting (ADR 0049):

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

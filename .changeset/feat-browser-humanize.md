---
"turno-browser": minor
"turno-cli": minor
---

Human-like input for browser identities, off by default. `turno identity set browser:<id> --humanize light|full|adaptive` (or `turno-browser-mcp --humanize <level>`, which wins) makes the stock click, hover, type, fill form, select, drag, press key and coordinate tools, and `browser_batch`, move the pointer along a curve from where it last was to a point inside the target, hold the button for tens of milliseconds and type short text key by key with per-key delays. `full` adds a move time that follows distance and target size, overshoot and correction, a reading pause on a new page, longer gaps between words and wheel scrolling; `adaptive` is `light`, and `full` on a site where the identity met a challenge page. Tool names, arguments and results do not change. The setting is the `humanize` key of identity.json (format 4, with an optional `seed`), and turno-cli needs turno-browser API 1.3 for it.

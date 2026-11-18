---
"turno-browser": patch
---

The idle limit no longer closes Chrome in the middle of a tool call. It counted from the start of
the last call, so a call that took longer than `TURNO_BROWSER_IDLE` (a slow page, a busy machine)
failed with "Target page, context or browser has been closed". It now stops while a call runs and
counts from the end of the last one.

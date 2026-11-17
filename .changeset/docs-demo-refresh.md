---
"turno-cli": patch
"turno-browser": minor
---

Neutral engine ids for `turno browser bench`, and a README demo of the current CLI.

- `turno browser bench` names its engines by browser and mode: `chrome-headed`,
  `chrome-headless`, `chrome-baseline` and `firefox`. The old ids (`patchright-chrome-headed`,
  `patchright-chrome-headless`, `playwright-stock`, `camoufox`) are still accepted by `--engine`,
  and the report (table and `--json`) uses the new ones. turno-cli keeps working with an older
  turno-browser.
- The README demo is recorded from `turno demo` in a throwaway HOME and shows the status screen,
  `turno init --dry-run`, profiles, the profile picker, `turno doctor` with its fix lines,
  `turno mcp list` and `turno limit show`.

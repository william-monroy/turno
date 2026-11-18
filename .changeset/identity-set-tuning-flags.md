---
"turno-cli": minor
---

`turno identity set browser:<id>` and `turno browser set <id>` take flags for every identity.json
key of the browser host: `--tabs-max`, `--tabs-popups`, `--tabs-park`, `--tabs-close` and
`--no-tabs` (tab governor), `--background-throttling`, `--settle`, `--block-trackers`,
`--block-types`, `--block-patterns` and `--no-block`, `--cache`, `--cache-max-size` and
`--no-cache`. A flag changes only its part of a group, an empty value removes a key, and a bad
value is refused with the flag's name. `set` takes `--json` (what changed, or with `--dry-run`
what would, and the resulting file), and `--dry-run` now validates like the real write.
`turno identity add browser:<id>` takes the same flags, and `show` lists the new settings.

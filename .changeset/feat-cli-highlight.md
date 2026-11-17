---
"turno-cli": minor
---

Syntax highlighting in a terminal, with no new dependencies.

- `turno init` shows the `config.toml` diff and the new `mcp.toml` with TOML colors: table headers bold, keys cyan, strings green, numbers, booleans and dates magenta, comments dim. The `+` and `-` markers keep their green and red, and removed lines stay plain red.
- `turno mcp import` colors its preview the same way, and a masked secret (the lines marked `# secret, hidden`) shows in yellow so it stands out. `turno mcp config` colors the JSON snippet and dims the file and note lines. `turno config set` colors the `key = value` it prints.
- `--json` output is colored when it goes to a terminal: keys cyan, strings green, numbers, booleans and null magenta. Piped into `jq` or a file it stays plain JSON, even with `FORCE_COLOR` set.
- Colors follow one rule everywhere: only on a terminal, never with `NO_COLOR` set. `FORCE_COLOR=1` now colors output that is not a terminal (for example `turno ... | less -R`), and `FORCE_COLOR=0` turns colors off on a terminal (`--json` is the exception: never colored outside a terminal). Output without colors is unchanged byte for byte.

---
"turno-cli": minor
---

Move MCP servers between machines, OAuth detection, Codex trust and next-step hints (ADR 0050):

- `turno mcp export [--profile p] [--json]` prints mcp.toml without secret values: references
  stay, literal secrets become `keychain:turno/<server>/<key>` names, and the top of the file
  lists the `turno secret set` commands the other machine needs.
- `turno mcp import <file>` merges an export, a JSON file with `mcpServers` or a Codex
  `config.toml` into mcp.toml, keeping its comments and existing servers (`--force` replaces
  them). A preview until `--write`.
- With `--write`, both import forms mark remote servers that answer with an OAuth challenge as
  `auth = "oauth"`.
- `turno profile assign` and `turno profile repair` write Codex `[projects."<folder>"]
  trust_level = "trusted"` entries in Codex profiles for their folder rules, never changing an
  existing entry.
- Commands that write end with a `Next:` line (`profile add`, `profile assign`, `mcp import
  --write`, `mcp export`, `secret set`); `turno config set hints false` turns them off.

---
"turno-browser": minor
"turno-core": minor
"turno-cli": patch
---

`turno-browser do` works without turno: it starts the identity's background server on the first action, keeps one session per agent or shell between commands, and ends it with `end`, `close` or when that process exits. `turno browser do` keeps going through mcpd.

New `turno-browser` commands: `setup <claude-code|codex|cursor|copilot|gemini|json> [--identity <id>]` prints the MCP config that gives an agent an identity (it writes nothing; `--json` for scripts), `background status|start|stop` shows and controls the background servers, and `secret set|has|list|remove` stores the `keychain:<item>` secrets identity.json names, in the same store and items as `turno secret`.

Hints, errors and doctor fixes name the commands of the program you typed: `turno-browser ...` on its own (the MCP server's messages too), `turno browser ...` and `turno identity ... browser:<id>` inside turno. `turno-browser doctor` lists a running background server, and a stdio server refused by a background server names `turno-browser background stop <id>`.

turno-core exports the owner, name and lock of a shell session of browser commands (`turno-core/cli`), shared by `turno browser do` and `turno-browser do`.

The npm description, keywords and MCP Registry entry follow the new tagline. Wording: the help no longer labels the off-by-default settings (natural language actions, captcha solving, network and user agent, Camoufox) as "not recommended"; they stay off by default and the help still says what each one sends where.

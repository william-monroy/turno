---
"turno-cli": minor
---

Set turno up in one step, or try it without touching your setup.

- New `turno init [--dry-run] [--yes]`: finds the agents on your PATH, your turno profiles, agent folders you made by hand (`~/.claude-work`, `~/.codex-cx`, ...), the MCP servers in your Claude Code, Codex, Cursor and Copilot CLI configs, and the folders each Claude Code account was used in. It proposes profiles, folder rules, a default profile and `mcp.toml`, prints everything (with the `config.toml` diff, the new `mcp.toml` with secrets masked, and any of your files it would move aside), asks, and writes it all as one change that one `turno undo` reverts. In a terminal it asks before adopting each folder; without one it needs `--yes`. `--profile <name[:agent]>`, `--skip <name>`, `--default <profile>` and `--no-mcp` answer the questions from the command line. It ends with what is left: signing in once per profile, `turno mcp daemon start`, `turno mcp sync` and `turno ui install`.
- New `turno demo` (also `npx turno-cli demo`, no install needed): builds a throwaway HOME in the temp folder with two Claude Code profiles, a folder rule, two small MCP servers behind a gateway on a free port, and the status line, then opens a shell there (`turno demo -- <command>` runs one command instead). It never reads or changes your own HOME and never signs in. When you leave, or press Ctrl-C while it waits, it stops the gateway and removes the folder.
- `turno help` starts with `turno init` and `turno demo`; `init` and `demo` can no longer be profile names.

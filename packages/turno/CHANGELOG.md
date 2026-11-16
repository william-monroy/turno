# turno-cli

## 0.1.1

### Patch Changes

- d28b959: `turno upgrade` recognizes a Homebrew install and runs `brew update` and `brew upgrade turno`
  instead of `npm install --global`.
- ce52d03: The repository moved to `github.com/wimo-dev/turno`. turno-browser is listed in the MCP
  Registry as `io.github.wimo-dev/turno-browser`.

## 0.1.0

First public release.

- One MCP gateway (`mcpd`) for every agent session: tool lists from a cache, servers started on
  first use, shared between sessions where it is safe, stopped when idle, secrets in the macOS
  Keychain. `turno mcp import`, `install`, `sync`, `config` and `doctor` move existing servers
  behind it.
- Profiles for Claude Code, Codex CLI, GitHub Copilot CLI and Cursor CLI, each with its own
  login folder and launcher, and folder rules (`turno profile assign`, `turno auto
  [--agent]`). Claude Code profiles share conversations, skills and settings.
- Gateway entries for opencode, Gemini CLI, Goose, Crush, Droid and Kiro
  (`turno mcp config --agent <name>`).
- The Claude Code status line with usage per account, its font and terminal setup
  (`turno ui install`).
- The accounts bridge, a builtin MCP server that delegates a task to a service account another
  profile is signed into, with confirmation for writes and an audit log.
- `turno status`, `doctor --fix`, `--json` on reads, `--dry-run` and `turno undo` on writes,
  shell completion, `turno upgrade`, and a daily update check that honors `DO_NOT_TRACK`.

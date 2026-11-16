---
"turno-cli": minor
---

`turno undo` reverts a whole profile setup, and `turno uninstall` removes what turno set up.

- `turno profile add` and `turno profile repair` now record the links, launchers and folders they create, the links and empty folders they replace, and the files they move to `.aside-<time>/`. `turno undo <stamp>` removes those links and launchers, moves your own files back, removes the `.aside-*` folder and the profile folder when it is empty again. A profile folder that holds a login (or anything made since) stays. `profile repair` prints its own `undo with:` line, and a launcher that did not change is no longer rewritten.
- New `turno uninstall [--dry-run] [--yes] [--keep-config]`: stops mcpd and removes its LaunchAgent or systemd user unit, removes the MCP entries `turno mcp sync` added (your own entries stay), puts back the status line you had before `turno ui install` (or removes turno's), removes the launchers turno wrote, its fish completion file, the gateway token and `~/.config/turno` (kept with `--keep-config`). It prints the full list first, asks in a terminal and refuses without one unless `--yes`. Profile folders, browser profiles, backups and Keychain secrets stay and are listed; shell startup lines that load turno's completion are listed to remove by hand. The run is journaled, so `turno undo <stamp>` puts everything back while turno is still installed. The last line is the command that removes the package (`npm uninstall --global turno-cli`, or `brew uninstall turno`).

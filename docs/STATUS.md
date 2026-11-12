# Status

Last updated: 2026-11-12.

## Done

- **Core** (`packages/claudio/src/core`): XDG paths, `config.toml` and `mcp.toml` parsing,
  profile discovery, folder resolution with fallback, exhausted marks, rate-limit parsing,
  Keychain secrets, live sessions and busy profiles.
- **CLI**: every command of the original bash tool, in English, with the Spanish names kept as
  hidden aliases (`uso`, `agotada`, `limite`, `abrir`, ...). Profile launches replace the
  process with `process.execve`, so no Node parent stays behind. `migrate` imports the legacy
  config and state without touching the originals.
- **mcpd**: the gateway (ADR 0002), its daemon with manifest reload on change or SIGHUP, the
  LaunchAgent, `mcp sync | import | install | refresh | doctor | list`, `secret`, and the
  `lsof` fallback that finds the client PID when a session sends none. An end-to-end test drives
  the real `claude mcp list` through the gateway (skipped when `claude` is missing; set
  `CLAUDIO_SKIP_E2E=1` to skip it).
- **Stealth browser** (`packages/browser`): `claudio-browser-mcp` over Patchright's own MCP
  entry, identities, `login`, `bench`. Findings in ADR 0005.
- **Accounts bridge**: registry, audit log, enforced headless delegation, the `accounts`
  builtin with elicitation for writes, `claudio accounts`.
- **Status line** (`claudio statusline`) and **handoff** (`claudio handoff`), replacing the
  Python status line and the two shell helpers.
- **Look of Claude Code** (`claudio ui`, `packages/fonts`): bundles MesloLGS Nerd Font 3.4.0
  with pinned checksums. That is the Nerd Fonts release Orca ships, so the icons match Orca's
  shapes and full size. It installs the font per user, points the shared `statusLine` at
  `claudio statusline`, sets the font in Warp, VS Code, Cursor and Alacritty when asked, and
  records Nerd-capable terminals in `nerd_terminals`, so `icons = "auto"` never draws empty
  boxes. `migrate` records them too. A test checks every status line icon against the bundled
  font. Guide: [ui.md](ui.md).
- **Plugin** (`plugins/claudio`): rate-limit hook, `switch-account` and `fork-session` skills,
  and a local marketplace manifest at the repository root.

## Known gaps

- `migrate --rollback <stamp>` from design section 9 is not implemented. Backups exist under
  `~/.local/state/claudio/backups/<stamp>/` and can be restored by hand.
- Delegated "read" tasks get the same tool patterns as writes; the read-only promise is in the
  prompt only. Enforcing it needs read-only patterns per account in `accounts.toml`.
- Headless stealth browsing is detectable from the user agent and storage partitioning
  (ADR 0005). Headed is the default.
- `claudio browser login` has not been exercised with a real sign-in yet.
- The design doc says `claudio-navegador` stays as a symlink; `setup` rewrites it as a marked
  copy of `claudio-open` instead. Same effect.

## Dry run against a real setup (2026-11-12, read only)

- `migrate --dry-run` produced the expected rules, fallback and Chrome profile directory. The
  legacy config had no `color` lines (the old status line hard-coded them), so pill colors must
  be added to `config.toml` at cutover to keep the same look.
- `mcp import` found 4 stdio servers and 6 remote ones; secrets were detected in one stdio env
  and two remote headers. Fixed: with several bins, the importer now picks the one npx runs.
- `mcp sync --dry-run` planned gateway entries for every profile and the hub config.
- `mcp doctor` showed that the two heaviest browser servers come from plugins and start in
  every session; declaring them as `session` servers in mcp.toml is the main memory win.
- Status line: 55 ms per render, same as the Python version (53 ms). Same input, side by side
  in Warp mode: same layout and icons.
- `ui install --terminal all --no-statusline` ran on the real machine: MesloLGS Nerd Font 3.4.0
  is in `~/Library/Fonts` (macOS lists the family) and Warp (was MesloLGS NF 2.3.3), VS Code and
  Cursor (were `monospace`) use it, one changed line per file, backups under
  `backups/<stamp>/ui/`. No config.toml was written: `migrate` records `nerd_terminals`. Until
  the cutover the Python status line still draws Nerd icons only in Orca and Warp.

## Next

1. **Cutover** (needs the owner, live sessions must close): `migrate`, `mcp import --write
   --move-secrets`, `mcp install`, `mcpd start`, disable plugin stdio servers covered by the
   manifest, `mcp sync`, `setup` to regenerate launchers, swap `~/.local/bin/claudio`, `ui install`
   (font and terminals are done; this switches the statusLine to claudio), point the StopFailure hook at the
   new CLI (or install the plugin).
2. Measure: RSS of MCP processes before and after with the same open sessions.
3. Packaging for others: npm names (deferred, ADR 0004), a Homebrew formula, CI.

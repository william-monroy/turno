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
- Statusline latency: Node start is about 40 to 60 ms per render; fine for now, worth
  measuring against the Python version after cutover.

## Next

1. **Dry run on the owner's machine without cutover**: build, link as `claudio-next`, run
   `claudio-next migrate --dry-run`, `claudio-next mcp import`, `claudio-next mcp sync
   --dry-run`, compare with the live setup.
2. **Cutover** (needs the owner, live sessions must close): `migrate`, `mcp import --write
   --move-secrets`, `mcp install`, `mcpd start`, disable plugin stdio servers covered by the
   manifest, `mcp sync`, `setup` to regenerate launchers, swap `~/.local/bin/claudio`, point
   the status line and the StopFailure hook at the new CLI (or install the plugin).
3. Measure: RSS of MCP processes before and after with the same open sessions.
4. Packaging for others: npm names (deferred, ADR 0004), a Homebrew formula, CI.

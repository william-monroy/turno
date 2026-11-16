# Status

Last updated: 2026-11-13.

## Done

- **Core** (`packages/turno/src/core`): XDG paths, `config.toml` and `mcp.toml` parsing,
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
  `TURNO_SKIP_E2E=1` to skip it).
- **Stealth browser** (`packages/browser`): `turno-browser-mcp` over Patchright's own MCP
  entry, identities, `login`, `bench`. Findings in ADR 0005.
- **Accounts bridge**: registry, audit log, enforced headless delegation, the `accounts`
  builtin with elicitation for writes, `turno accounts`.
- **Status line** (`turno statusline`) and **handoff** (`turno handoff`), replacing the
  Python status line and the two shell helpers.
- **Look of Claude Code** (`turno ui`, `packages/fonts`): bundles MesloLGS Nerd Font 3.4.0
  with pinned checksums. That is the Nerd Fonts release Orca ships, so the icons match Orca's
  shapes and full size. It installs the font per user, points the shared `statusLine` at
  `turno statusline`, sets the font in Warp, VS Code, Cursor and Alacritty when asked, and
  records Nerd-capable terminals in `nerd_terminals`, so `icons = "auto"` never draws empty
  boxes. `migrate` records them too. A test checks every status line icon against the bundled
  font. Guide: [ui.md](ui.md).
- **Plugin** (`plugins/turno`): rate-limit hook, `switch-account` and `fork-session` skills,
  and a local marketplace manifest at the repository root.
- **Command tree** (ADR 0006): `profile`, `limit`, `session`, `identity`, `run`, `mcp daemon`,
  plus `config`, `undo`, `completion`, `version`, `upgrade`; the 0.1 and Spanish names stay as
  aliases in `cli/registry.ts`. Shared flags (`--json` on reads, `--dry-run` on writes, `-n`,
  `--watch`, `--until`), a sectioned help, `status` as a one-screen summary, `doctor` with every
  check and `--fix`, shell completion fed by each command's declared arguments.
- **Journal and undo** (ADR 0008): every write to a user file goes through `core/journal.ts`;
  `turno undo <stamp|last>` restores, skips files changed since, and can be undone itself.
  This is the `migrate --rollback` of the design.
- **Versions and updates** (ADR 0007, [RELEASING.md](RELEASING.md)): Changesets, CI and release
  workflows (npm with provenance), `scripts/pack-check.mjs`, `turno upgrade` per install
  method with `--finish` (launchers, changelog), a daily background update check. Packages stay
  `private` until the owner settles the name and publishing (see Next).
- **Open-source groundwork** (2026-11-13, from the maintainer's research on licensing,
  governance and release practice):
  - Apache-2.0 with NOTICE, REUSE metadata, font icon-set attributions, `THIRD_PARTY_NOTICES.md`
    and a license allow list in `pnpm check` (ADR 0010).
  - CONTRIBUTING, Code of Conduct (Covenant 3.0), SECURITY with the security model, GOVERNANCE,
    AI policy, SUPPORT, issue forms, pull request template; `AGENTS.md` holds the agent rules and
    `CLAUDE.md` imports it; a `commit-msg` hook (`pnpm hooks`).
  - Release pipeline split into version, build, publish and tag jobs; SHA-pinned actions,
    zizmor, Scorecard, Dependabot, Harden-Runner; Node 22/24/26 and `engines >=22.11`; pnpm
    release-age, trust and engine policies; `DO_NOT_TRACK` honored (ADR 0011).
  - README disclaimers (not affiliated, vendor terms, no warranty, update check), `fallback`
    documented as opt-in, the browser described without "stealth" and with an acceptable use
    section (ADR 0012).
- **Other agents** (ADR 0013, [agents.md](agents.md)): Codex, Copilot and Cursor profiles with
  their launchers, per-agent folder rules and defaults, gateway entries per format (token kept in
  the environment for all three), `turno mcp config` snippets for opencode, Gemini CLI, Goose,
  Crush, Droid and Kiro. End-to-end tests drive the real Codex and Cursor CLIs in a sandbox.

## Known gaps

- Backups written before the journal (the 2026-11-12 `ui install`) have no `journal.json`;
  `undo --list` shows them as restore-by-hand.
- `accounts.toml` is regenerated on write (comments are not kept); config.toml edits keep them.
- Delegated "read" tasks get the same tool patterns as writes; the read-only promise is in the
  prompt only. Enforcing it needs read-only patterns per account in `accounts.toml`.
- Headless stealth browsing is detectable from the user agent and storage partitioning
  (ADR 0005). Headed is the default.
- `turno browser login` has not been exercised with a real sign-in yet.
- Copilot CLI profiles follow its documentation only (not installed here). Codex cross-account
  resume through the shared `sessions` folder is untested with two ChatGPT accounts. Cursor's
  per-profile login relies on the undocumented `AGENT_CLI_CREDENTIAL_STORE=file`.
- The design doc says `claudio-navegador` stays as a symlink; `setup` rewrites it as a marked
  copy of `turno-open` instead. Same effect.

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
- `doctor` on the real machine (read only): the four profiles miss the `keybindings.json` link and
  run bash launchers (`profile repair` at the cutover fixes both); four stdio servers in the hub
  config and two plugin servers bypass mcpd. Files Claude Code added since (`daemon.lock`,
  `daemon.status.json`, `feedback`, the `*.signature.json` and `synced-at` files) are classified
  as per account.

## Next

0. **Public release** (2026-11-16): the owner accepted the trademark risk of the name and chose
   to publish under `github.com/william-monroy/turno`, moved the same day to
   `github.com/wimo-dev/turno` (ADR 0015). Done in the repository: README rewritten
   around the measured gateway saving ([BENCHMARKS.md](../BENCHMARKS.md), `bench/`), Spanish
   README, logo, VHS demo (`docs/demo/`), social preview, package metadata, changelogs for
   0.1.0, `server.json` for the MCP Registry, plugin texts without rate-limit wording.
   Published the same day: `turno-cli`, `turno-browser` and `turno-fonts` 0.1.0 on npm (the
   name `turno` was refused, ADR 0014), each with a trusted publisher for `release.yml` and the
   `npm` environment and "require 2FA, disallow tokens"; the Homebrew tap
   `wimo-dev/homebrew-turno`; `turno-browser` in the MCP Registry (as
   `io.github.william-monroy/turno-browser`, now deprecated in favour of
   `io.github.wimo-dev/turno-browser`);
   cobalt logo and social preview; Discussions with an Español category and the pinned roadmap.
   Left:
   GitHub Actions never started on the owner's personal account (a billing lock); in the
   `wimo-dev` organization it runs. The first CI run found that `node --test scripts/` only
   works on Node 26 (fixed) and zizmor asked for a 7 day Dependabot cooldown. 0.1.1 of the three
   packages was the first release through `release.yml`: version pull request, `npm`
   environment approval, publish with provenance, tags and GitHub releases. The tap follows it.
   - the Claude Code community marketplace and awesome lists (from 2026-11-26);
   - a lawyer's read of the vendor terms notice, and Cursor's and Copilot's terms on several
     accounts, before the launch post promises anything about those agents;
   - the backup administrator in GOVERNANCE.md;
   - optional later: Starlight docs site, OpenSSF Best Practices badge, GitHub Sponsors.

1. **Cutover** (needs the owner, live sessions must close): `migrate`, `mcp import --write
   --move-secrets`, `mcp install`, `mcpd start`, disable plugin stdio servers covered by the
   manifest, `mcp sync`, `profile repair` to regenerate launchers and links, swap `~/.local/bin/claudio`, `ui install`
   (font and terminals are done; this switches the statusLine to turno), point the StopFailure hook at the
   new CLI (or install the plugin).
2. Measure the owner's own sessions before and after the cutover with `bench/` style RSS sums
   and add them to BENCHMARKS.md as a real-world row.
3. Phase 3 of the command proposal: the Claude Code plugin with slash commands, exhaustion
   warnings and auto handoff, external `turno-<x>` subcommands, export and import, Linux
   secrets and service.

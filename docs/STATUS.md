# Status

Last updated: 2026-11-17.

## Done

- **Core** (`packages/turno/src/core`): XDG paths, `config.toml` and `mcp.toml` parsing,
  profile discovery, folder resolution with fallback, exhausted marks, rate-limit parsing,
  secrets in the macOS Keychain or the Linux Secret Service, live sessions and busy profiles.
- **CLI**: every command of the original bash tool, in English, with the Spanish names kept as
  hidden aliases (`uso`, `agotada`, `limite`, `abrir`, ...). Profile launches replace the
  process with `process.execve`, so no Node parent stays behind. `migrate` imports the legacy
  config and state without touching the originals.
- **mcpd**: the gateway (ADR 0002), its daemon with manifest reload on change or SIGHUP, the
  LaunchAgent (and the `systemd --user` unit, below), `mcp sync | import | install | refresh |
  doctor | list`, `secret`, and the
  `lsof` fallback that finds the client PID when a session sends none. An end-to-end test drives
  the real `claude mcp list` through the gateway (skipped when `claude` is missing; set
  `TURNO_SKIP_E2E=1` to skip it).
- **Browser package** (`packages/browser`): `turno-browser-mcp`, identities, `login`, `bench`.
  Since ADR 0043 (stage 1) it is the MCP server host: it parses upstream's flags, launches Chrome
  through one engine module, runs the 25 stock tools through upstream's `BrowserBackend` and has
  a turno tool registry (empty for now). Findings in ADR 0005; a separate package and a developer
  diagnostic since ADR 0019. Lifecycle (ADR 0042, stage 0 of the browser plan): Chrome closes
  after 15 idle minutes headed too (a generated `--config`), a Chrome left by a killed server is
  swept on the next start, shutdown is bounded to fit mcpd's 4 seconds, one scope advice
  (`shared` + `exclusive` for identities), session servers stop under critical memory pressure,
  `mcp top` counts Chrome's process group; real Chrome tests and an upstream contract test.
  Identity module (ADR 0044): `identity.json` next to each profile (time zone, languages, locale,
  region, health check) applied at every Chrome start, `turno identity add/show/set`; a runtime
  lock `{ nodePid, chromePid, pgid, startedAt }` with a clear "in use by" message; session health
  (NEEDS_AUTH as a tool error that asks for `turno browser login`); a per-site reputation log of
  challenges with `turno browser reputation`; `turno browser doctor [--fix]`; and `stop_grace`
  per server in mcpd (5 s for turno-browser-mcp).
- **Documentation site** (`apps/docs`, ADR 0046): Fumadocs (Next.js), a private workspace app
  for `https://turno.wimo.dev` (not deployed yet). Get started, guides by problem, concepts,
  security, benchmarks, comparison and FAQ are written by hand from the README and `docs/`;
  the reference (commands, `config.toml`, `mcp.toml`, environment, exit codes, JSON) and one
  troubleshooting page per doctor finding are generated from the code by `pnpm docs:generate`
  and checked in the `docs` workflow, with the build and a link check. Four diagrams, text
  recordings rendered from VHS tapes, Spanish for Get started and the FAQ, `llms.txt` and a
  Markdown copy of every page.
- **Accounts bridge**: registry, audit log, enforced headless delegation, the `accounts`
  builtin with elicitation for writes, `turno accounts` (now `turno identity`). Policy and
  isolation since ADR 0024, below.
- **Status line** (`turno statusline`) and **handoff** (`turno handoff`), replacing the
  Python status line and the two shell helpers.
- **Look of Claude Code** (`turno ui`, `packages/fonts`): bundles MesloLGS Nerd Font 3.4.0
  with pinned checksums. That is the Nerd Fonts release Orca ships, so the icons match Orca's
  shapes and full size. It installs the font per user, points the shared `statusLine` at
  `turno statusline`, sets the font in Warp, VS Code, Cursor and Alacritty when asked, and
  records Nerd-capable terminals in `nerd_terminals`, so `icons = "auto"` never draws empty
  boxes. `migrate` records them too. A test checks every status line icon against the bundled
  font. Guide: [ui.md](ui.md).
- **Plugin** (`plugins/turno`, 0.2.0): rate-limit hook, `switch-account`, `fork-session` and
  `copy-artifact` skills, and a local marketplace manifest at the repository root.
  `copy-artifact` (ADR 0038) copies a claude.ai artifact between profiles in two steps, with two
  dependency-free Node scripts (`pack.mjs`, `relink.mjs`) tested in `scripts/copy-artifact.test.mjs`.
- **Command tree** (ADR 0006): `profile`, `limit`, `session`, `identity`, `run`, `mcp daemon`,
  plus `config`, `undo`, `completion`, `version`, `upgrade`; the 0.1 and Spanish names stay as
  aliases in `cli/registry.ts`. Shared flags (`--json` on reads, `--dry-run` on writes, `-n`,
  `--watch`, `--until`), a sectioned help, `status` as a one-screen summary, `doctor` with every
  check and `--fix`, shell completion fed by each command's declared arguments.
- **Journal and undo** (ADR 0008): every write to a user file goes through `core/journal.ts`;
  `turno undo <stamp|last>` restores, skips files changed since, and can be undone itself.
  This is the `migrate --rollback` of the design. Profile setup and `turno uninstall` are
  journaled too since ADR 0025, below.
- **Versions and updates** (ADR 0007, [RELEASING.md](RELEASING.md)): Changesets, CI and release
  workflows (npm with provenance), `scripts/pack-check.mjs`, `turno upgrade` per install
  method with `--finish` (launchers, changelog), a daily background update check. Published
  on npm since 0.1.0 (ADR 0014).
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
- **Wave 1 (2026-11-16, PRs #17 to #25)**, from the pre-launch audit:
  - Call lifecycle and routing (ADR 0016): cancellation upstream on Esc, session end or the
    optional `call_timeout`; `mcp.toml` edits apply to open sessions; elicitation and sampling
    reach only the session whose call asked, refused when several are mid-call; `roots/list`
    from the session folder; the folder sent base64url (`X-Turno-Cwd-B64`); `resources/list`
    always forwarded, never cached; `POST /refresh`; a start circuit breaker with backoff;
    sessions rebuilt after an mcpd restart instead of 404.
  - Daemon (ADR 0017): `systemd --user` unit on Linux next to the LaunchAgent; one instance on a
    fixed port that fails loudly when the port is busy; the last valid `mcp.toml` kept serving;
    `turno mcp token rotate`; log rotation; `mcp daemon stop` removes the service file.
  - Secrets and files (ADR 0018): Linux Secret Service through `secret-tool`; values on stdin,
    never in argv; folders 0700 and files 0600; backups pruned after 30 days keeping the newest
    10 (`turno undo --prune`); the audit log hash-chained; `turno open` only for http(s) and
    mailto, and on Linux with `xdg-open`.
  - Lean install (ADR 0019): `turno-browser` and `turno-fonts` out of the default install,
    `npm-shrinkwrap.json` for `turno-cli` and `turno-browser`, no install scripts (checked in
    CI), `turno browser` as a developer diagnostic, `--allow-http-identity`.
  - `mcp import` and `mcp install` (ADR 0020): strict flags on every `turno mcp` subcommand,
    previews with secrets masked until `--write`, the `env:NAME:-default` form, exact versions,
    no install scripts unless `--allow-scripts`, a lockfile per server.
  - No silent account fallback (ADR 0021): `turno auto` exits 1 with the fixing command
    (`TURNO_ALLOW_PLAIN=1` for a broken config), `system = ""` for no default account,
    `agents.<agent>.default` and `fallback`, `turno config check`; `setup` hidden behind
    `turno profile repair`.
  - Status line (ADR 0022): each part fails alone and the line is never replaced by an error,
    `$?` (or Claude Code's figure) for unpriced models, `mcpd down`; tests run under a guard
    HOME that fails the run if anything lands outside the sandbox, and `pnpm test:e2e` runs the
    network end-to-end test that `pnpm check` skips.
  - Undo of profile setup and `turno uninstall` (ADR 0025).
- **Wave 2 (PRs #26 to #30)**:
  - Per-profile gateway tokens and tool filters (ADR 0023): the token decides the profile, the
    master token only opens `/status` and `/refresh`, `tools = { allow, deny }` per server and
    variant.
  - Accounts bridge policy (ADR 0024): `read_tools` and `confirm` per account, headless runs
    in an empty folder with no settings files, a minimal environment and a strict MCP config
    when the account's servers go through the gateway; the decision in every audit line.
  - Call log, `turno mcp log`, `top` and `savings` (ADR 0026).
  - `turno doctor --security` (with `--fix` for file modes), `turno identity log --verify`,
    `${VAR}` expansion in mcpd, `mcpd.max_request_body` (ADR 0027).
  - `turno init`, one-journal onboarding, and `turno demo` in a throwaway HOME (ADR 0030).
    `turno init` also starts the gateway and runs `mcp sync` in the same journal (asked in a
    terminal, `--start` with `--yes`). Bare `turno` is the status screen once set up, and
    `turno status` ends with the next step.
- **Wave 3 (PRs #31 to #34)**:
  - MCP 2026-07-28 next to 2025-11-25 on the same endpoint, and `idle_under_pressure` (ADR
    0028).
  - OAuth for remote servers, once per variant, in the gateway: `turno mcp login`, `logout`
    (ADR 0029).
  - Folder server sets (`mcp`, `mcp_deny` on `[[projects]]` rules, ADR 0031), also for
    2026-07-28 clients and OAuth remotes; `config.toml` reloaded live; the next full
    `turno mcp sync` removes the token files of removed profiles; `upgrade --finish` offers the
    sync; tool filters in `mcp list` and without a restart.
  - The agent adapter boundary (ADR 0032, refines ADR 0013): one adapter file per agent; Biome
    and knip in `pnpm check`; an agent JSON config that is valid JSON but not an object is
    reported instead of rewritten.
- **Wave 7, stage 4: the output contract** (ADR 0045): one output layer for `--json` with
  `schemaVersion` in every object (each element of a list), `--json=fields` and `--json=a,b`,
  NDJSON for `limit show --watch --json`, `mcp top --watch --json` and `mcp log -f --json`, and
  JSON errors on stderr; exit codes 0 to 5 (`turno help exit-codes`, `turno profile which
  --check`; `turno auto` exits 3 and the mcp commands 5 where they exited 1); `readState` with
  small guards and format versions for turno's state files; `loadOptional` for turno-browser and
  a future turno-tui; `turno help environment` and `json`, examples in every help, `CLICOLOR`,
  `CLICOLOR_FORCE`, `TERM=dumb` and `TURNO_NO_UPDATE_NOTIFIER`.
- **Wave 7, stage 3: cross-package contracts** (ADR 0047): turno-browser exports a typed `api`
  object and `API_VERSION`, which the CLI types with `import type` (the hand-typed
  `BrowserModule` is gone) and checks at load, with one message for a package that is too old or
  too new; one call middleware in mcpd for every `tools/call` of both protocol paths (tool
  filter, call log, session id; named opt-in stages, none yet); `_meta["io.turno/session"]` on
  forwarded calls, read by turno-browser's host into its tools' context.
- **Diagnostics and safe mode** (ADR 0049): `turno mcp call <server> [tool]` through mcpd with a
  profile's token and this folder; `turno doctor --report` (a Markdown block for issues, no
  secrets) and `turno config path --all`; `--no-gateway` and `TURNO_SAFE=1` for `turno run`,
  `turno <profile>` and `turno auto`, per agent through the adapter's `safeMode`; Copilot CLI
  and Cursor CLI gateway entries send the session folder header; `system = ""` reads as "no
  account" in status, which, sessions and the hub's gateway token.
- **Export, import and hints** (ADR 0050): `turno mcp export` (mcp.toml with secrets by name
  only) and `turno mcp import <file>` (merges an export or another agent's config, keeping
  comments); `auth = "oauth"` for remotes that answer with an OAuth challenge on `--write`; Codex
  `[projects]` trust entries for folder rules; `Next:` lines after writes, `hints = false`.

## Known gaps

- Backups written before the journal (the 2026-11-12 `ui install`) have no `journal.json`;
  `undo --list` shows them as restore-by-hand.
- `accounts.toml` is regenerated on write (comments are not kept); config.toml edits keep them.
- Accounts bridge: an account whose tools are claude.ai connectors (`mcp__claude_ai_*`) runs
  with the profile's MCP config, because `--strict-mcp-config` does not load connectors; the
  allowed tools are the limit there. turno cannot tell whether a tool only reads: `read_tools`
  are what the user lists.
- MCP 2026-07-28 clients cannot answer elicitation or sampling through mcpd, the tasks
  extension is not offered, and servers that speak only 2026-07-28 are not supported upstream
  (mcpd speaks 2025-11-25 to every server, ADR 0028).
- Folder server sets are not a boundary: a session whose folder mcpd cannot learn sees every
  server, and remote servers written straight into profiles cannot be hidden.
- Removing a profile does not revoke its gateway token; `turno mcp token rotate` does (for
  every profile).
- Headless browsing is detectable from the user agent and storage partitioning (ADR 0005).
  Headed is the default.
- `turno browser login` has not been exercised with a real sign-in yet.
- Browser memory inside one Chrome is still unbounded while it is in use: no tab cap, popups
  stay open, background tabs are not throttled (ADR 0042 leaves them to the later stages).
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
   - optional later: OpenSSF Best Practices badge, GitHub Sponsors. Docs site: deploy
     `apps/docs` to `turno.wimo.dev` (Vercel project and DNS); give doctor checks an `id` in
     the code so the troubleshooting catalog stops matching on text; shrink the README once
     the site is live.

1. **Cutover** (needs the owner, live sessions must close): `migrate`, `mcp import --write
   --move-secrets`, `mcp install`, `mcpd start`, disable plugin stdio servers covered by the
   manifest, `mcp sync`, `profile repair` to regenerate launchers and links, swap
   `~/.local/bin/claudio`, `ui install` (font and terminals are done; this switches the
   statusLine to turno), point the StopFailure hook at the new CLI (or install the plugin).
   Every existing install, after upgrading past 0.1.1: `turno mcp sync` (per-profile tokens,
   ADR 0023, and the `X-Turno-Cwd-B64` header) and `turno profile repair` (new launchers);
   `turno upgrade --finish` rewrites the launchers and offers the sync.
2. Measure the owner's own sessions before and after the cutover with `bench/` style RSS sums
   and add them to BENCHMARKS.md as a real-world row.
3. Phase 3 of the command proposal: the Claude Code plugin with slash commands, exhaustion
   warnings and auto handoff, external `turno-<x>` subcommands, export and import.
4. **Follow-ups** from the three waves, still open on main (checked 2026-11-16):
   - mcpd: a random port per install instead of 47821; check the Copilot CLI header expansion
     of `X-Turno-Cwd-B64` against the real CLI (ADR 0049); tools-only variants sharing the default
     process (today a variant with only `tools` is its own process and, for OAuth, its own
     login); `list_changed` for stateless 2026-07-28 clients (sessions get it since 0.2).
   - MCP SDK v2 migration: elicitation and sampling for 2026-07-28 clients, 2026-07-28-only
     upstreams; an end-to-end test once an agent defaults to 2026-07-28.
   - OAuth: host a turno Client ID Metadata Document at a project HTTPS URL.
   - CLI: the OAuth login state for doctor without the
     MCP SDK (`loginState` lives in `mcpd/oauth.ts`, which imports it).
   - Accounts bridge: a rate limit per session; opt-in extra environment for runs (Bedrock,
     Vertex); verify that strict MCP runs reach the gateway with per-profile tokens on a real
     setup.
   - Release and repository: `egress-policy: block` for the version and build jobs; the
     Homebrew formula as an `npm ci` recipe against the shrinkwrap (ADR 0019); a real
     `turno mcp savings --json` number for the launch post. (Done: neutral bench engine ids and
     the VHS tape recorded from `turno demo` in an empty environment, ADR 0041.)
   - Code health (ADR 0032): the Biome formatter; `exactOptionalPropertyTypes` once the MCP SDK
     allows it; `parseConfig` without its env default; `journal` `real()`. (Done: guards for the
     `JSON.parse` casts on state files, ADR 0045.)

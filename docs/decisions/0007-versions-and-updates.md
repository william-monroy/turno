# 0007. Versions, releases and updates

Date: 2026-11-12. Status: accepted (publishing waits for the owner).

## Context

Other people will install claudio, so it needs versions they can trust and a way to update
that does not depend on how they installed it. claudio is Node with optional packages (the
browser server, the fonts), runs on macOS and Linux, and writes files outside its install
(launchers, settings, config) that must follow an upgrade.

Options considered:

- **npm registry** (recommended): the toolchain users already have; optional dependencies
  install only what they need; provenance links each tarball to the commit and CI run that
  built it; every package manager can install and update it.
- **Homebrew tap**: nice on macOS, but a formula for a Node CLI still pulls Node and npm, and
  it is a second channel to maintain. Worth adding later as a thin wrapper of the npm tarball.
- **Single binary** (Node SEA, bun compile): no Node needed, but the browser server ships a
  Playwright fork and Chrome profiles, the binary is large per platform, and updates need a
  custom updater. Not now.
- **curl | sh installer**: easy to start, hard to trust and to update. No.

## Decision

- Semantic versions per package, managed with Changesets: every user-visible change adds a
  `.changeset/*.md`; `pnpm version-packages` bumps versions and writes `CHANGELOG.md`.
- Releases come from CI only (`.github/workflows/release.yml`): Changesets opens a "Version
  packages" pull request, and merging it publishes to npm with provenance through npm trusted
  publishing (OIDC, no long-lived token). `scripts/pack-check.mjs` checks every tarball first:
  required files present, no tests, sources, maps or env files, no local home paths, size cap.
- The packages stay `"private": true` until the owner picks the npm name: `claudio` and
  `claudio-cli` are taken on npm, so it will be a scope (for example `@<scope>/claudio`). The
  command stays `claudio` whatever the package is called.
- `claudio version` and `claudio --version` read package.json. `claudio upgrade` detects the
  install (npm, pnpm, yarn, bun, volta, or a git checkout) and runs the matching command, then
  runs `claudio upgrade --finish` from the new version: it rewrites launchers (they bake the
  path of claudio, which some package managers change per version), checks the config and
  prints the CHANGELOG entries since the version recorded in `state/version`. `doctor` flags a
  version mismatch and `doctor --fix` finishes it.
- Update notice: interactive commands (never the hot paths: status line, hooks, launchers,
  `auto`, `open`) start a background registry check at most once a day and mention a newer
  version once a day on stderr. The request sends only the package name. It is off for
  private copies, in CI, with `CLAUDIO_NO_UPDATE_CHECK` or `NO_UPDATE_NOTIFIER`, and with
  `update_check = false` in config.toml. `--channel next` follows prereleases.

## Consequences

- Breaking changes (renamed commands, config keys, file layouts) need a major version, an
  alias or a migration step in `upgrade --finish`, and a changeset that says what to do.
- Publishing needs the owner: an npm account or organization, the package name, and the
  trusted publisher set on npmjs.com for the repository and workflow.

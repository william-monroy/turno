# 0011. A release pipeline where the publishing job runs no project code

Date: 2026-11-13. Status: accepted.

## Context

On 2026-05-11 the Mini Shai-Hulud attack published malicious versions of dozens of npm
packages with valid provenance. The chain: a `pull_request_target` workflow ran fork code,
poisoned the pnpm store cache, and the release job restored that cache, ran it, read the OIDC
token from the runner and published. The first `release.yml` of this repository had three of
the four ingredients: `id-token: write` at workflow level, `cache: pnpm` in the publishing job,
and actions pinned by tag, with install and tests running next to the token.

Since 2026-09-03 npm trusted publishing stages every version until a maintainer approves it,
and npm 12 and pnpm 11+ add install-time defenses. Node 20 reached end of life on 2026-04-30.

## Decision

- `release.yml` has four jobs: `version` (Changesets pull request, no publishing rights),
  `build` (check, pack, SBOM; no `id-token`), `publish` (protected `npm` environment,
  `id-token`, no checkout, no install, no cache; attests and publishes the tarballs from the
  artifact), `tag` (git tags and GitHub releases). `scripts/release-plan.mjs` decides what to
  publish: every public package whose version npm does not have, with the prerelease id as the
  dist-tag.
- Every workflow: `permissions: {}` at the top, documented per-job permissions, actions pinned
  by full SHA, `persist-credentials: false`, Harden-Runner in audit mode, no
  `pull_request_target`. zizmor (pedantic persona) and OpenSSF Scorecard run in CI.
- Node policy: all LTS lines at release time (22, 24, 26 today); `engines` `>=22.11`.
- pnpm: `minimumReleaseAge` of three days (own packages excluded), `trustPolicy:
  no-downgrade`, `engineStrict`. Dependabot groups updates weekly with a three-day cooldown.
- Commit rules are enforced by a 40-line script (`scripts/commit-msg.mjs`) installed as a
  `commit-msg` hook with `pnpm hooks` (`core.hooksPath`), and run on pull request titles in CI.
  This replaces commitlint plus lefthook: no extra dependencies, no install script, and the
  same script also rejects attribution trailers and the em dash, which commitlint would need
  custom rules for.
- Changesets stays (v3 is already in use); semantic-release and release-please infer versions
  from commits, which fits a single package better than three independent ones.

## Consequences

- A release needs one manual approval on npmjs.com per package version.
- Raising `minimumReleaseAge` means a fresh dependency version is not installable for three
  days; a security fix that cannot wait goes in `minimumReleaseAgeExclude` for that release.
- Distribution stays npm first; a Homebrew tap that wraps the npm tarball and a single binary
  remain later options (ADR 0007).

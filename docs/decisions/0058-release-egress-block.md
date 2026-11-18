# 0058. Block network egress in every release job

Date: 2026-11-18. Status: accepted. Extends ADR 0011 (release pipeline and supply chain) and the supply chain
notes in `docs/RELEASING.md`.

## Context

`release.yml` splits the release into version, build, publish and tag jobs. Publish and tag ran
Harden-Runner with `egress-policy: block` and an allow list from the start; version and build
ran it in audit mode. Those two run project code with a full dependency install: version runs
`changeset version` and `pnpm install --lockfile-only` with a token that can push and open pull
requests, and build runs every test and packs what publish will upload. A compromised
dependency there could send the workspace, the token or a modified tarball anywhere.

Harden-Runner's insights for the 0.2.0 release (run 44210045228) list the hosts these jobs
reached: `github.com` and `registry.npmjs.org` for version, `registry.npmjs.org` for build, and
`api.github.com` for the version pull request. The Actions service hosts (artifacts, cache,
logs) are allowed by Harden-Runner itself.

## Decision

Version and build run with `egress-policy: block` and this list:

- `github.com`: checkout, and the push of the changesets branch;
- `api.github.com`: the version pull request, and pnpm/action-setup's release lookups;
- `registry.npmjs.org`: pnpm itself, `pnpm install`, the lockfile refresh and release-plan's
  `npm view`;
- `objects.githubusercontent.com`, `release-assets.githubusercontent.com`,
  `raw.githubusercontent.com` and `nodejs.org`: where pnpm/action-setup and setup-node download
  a tool that is not in the runner's cache (also in the publish job's list).

Tests in the build job reach only 127.0.0.1. On Linux the real Chrome tests run a Chrome that
also calls Google's update and safe browsing hosts; those are blocked and the tests do not need
them. The other workflows (ci, docs, install, scorecard, zizmor) stay in audit mode: they hold
no write token and their insights keep showing what a new step needs before it reaches a release.

## Consequences

- A new tool or download in a release job fails the release until its host is added. The
  failure names the blocked host in Harden-Runner's insights; `docs/RELEASING.md` says how to
  read them, add a host or go back to audit for one job.
- The lists can only be exercised on `main`: the release workflow does not run on pull
  requests. The first push to `main` after this change runs the version job (or the build job
  right after a version pull request is merged), and its insights confirm the list.

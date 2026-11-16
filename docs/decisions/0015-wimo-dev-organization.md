# 0015. The repository lives in the wimo-dev organization

Date: 2026-11-16. Status: accepted.

## Context

The repository was published as `william-monroy/turno`. GitHub Actions does not start on that
personal account ("account is locked due to a billing issue", from a failed Copilot charge,
although the plan is Free), so CI and `release.yml` could not run. Actions minutes and locks
belong to the account that owns the repository, and an organization on the Free plan has its
own. `wimodev`, the owner's folder name, is taken on GitHub by an empty organization from 2022;
`wimo-dev` is free on GitHub, npm, Bluesky and as `.dev`, `.com` and `.io` domains.

## Decision

Move `turno` and `homebrew-turno` to the organization `wimo-dev`, owned by the same person.

## Consequences

- GitHub redirects the old URLs, so links and clones keep working; every reference in the
  repository and the tap now says `wimo-dev`.
- The tap is `brew tap wimo-dev/turno`. `brew tap william-monroy/turno` keeps working through
  the redirect.
- The MCP Registry ties a server name to the GitHub namespace, so the server becomes
  `io.github.wimo-dev/turno-browser`. The registry checks it against the package's `mcpName`,
  which needs a new `turno-browser` release; `scripts/sync-server-json.mjs` keeps the version
  in `server.json` in step on every `changeset version`. The old entry is marked deprecated.
- The npm trusted publishers of the three packages point at `wimo-dev/turno`.

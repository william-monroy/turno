# 0014. The main npm package is turno-cli

Date: 2026-11-16. Status: accepted.

## Context

The first publish of `turno` was refused by the npm registry: "Package name too similar to
existing packages turbo, errno". The npm organization `turno` belongs to someone else, so
`@turno/cli` is not available either. `turno-browser` and `turno-fonts` were accepted and are
published as 0.1.0.

## Decision

Publish the CLI as `turno-cli`. The command it installs stays `turno` (the `bin` entry), and
the repository, docs, config folders and plugin keep the name turno. The package folder stays
`packages/turno`.

## Consequences

- Install with `npm install --global turno-cli` and try with `npx turno-cli@latest`.
- `turno upgrade` and the update check read the name from package.json, so they follow the
  rename without code changes.
- The sibling packages keep their names, so the three still sort together on npm.
- If the owner later gets the `turno` name (npm support can release a name that is blocked by
  similarity only), `turno-cli` can be deprecated with a message pointing at it.

# Versions and releases

claudio follows semantic versioning per package (`claudio`, `@claudio/browser`,
`@claudio/fonts`). Why this setup: [ADR 0007](decisions/0007-versions-and-updates.md).

## Every change

A change a user would notice gets a changeset in the same pull request:

```sh
pnpm changeset          # pick the packages, the bump (patch, minor, major) and write a summary
```

- **patch**: fixes, no new behavior.
- **minor**: new commands, flags or config keys; old names keep working.
- **major**: anything a user must act on: a removed command or key, a changed file layout.
  The changeset says what to do, and `claudio upgrade --finish` migrates what it can.

## A release

Releases come from CI, never from a laptop:

1. Merging to `main` runs `.github/workflows/release.yml`. With pending changesets, it opens a
   pull request "chore(release): version packages" that bumps versions and writes each
   `CHANGELOG.md`.
2. Merging that pull request runs the workflow again: `pnpm check`, `scripts/pack-check.mjs`
   on every tarball, then `changeset publish`, which publishes the new versions to npm with
   provenance and tags them.

`pnpm pack:check` runs the tarball check locally. Prereleases: `pnpm changeset pre enter next`,
then releases go to the `next` dist-tag (`claudio upgrade --channel next` follows them);
`pnpm changeset pre exit` ends it.

## Before the first publish

The packages are `"private": true` until these are done (they need the owner):

1. Pick the npm name. `claudio` and `claudio-cli` are taken, so use a scope you own:
   `@<scope>/claudio`, `@<scope>/claudio-browser`, `@<scope>/claudio-fonts`. Rename the
   packages and the imports of the optional ones (`@claudio/browser`, `@claudio/fonts`).
2. Create the GitHub repository, add `repository`, `homepage` and `bugs` to each package.json,
   and pin the workflow actions to commit SHAs (or let Dependabot do it).
3. On npmjs.com, add the repository and `release.yml` as the trusted publisher of each package.
4. Remove `"private": true` and add a changeset; the next release publishes.

## How users update

`claudio upgrade` updates with the tool that installed claudio (npm, pnpm, yarn, bun, volta) or
pulls and rebuilds a git checkout, then `claudio upgrade --finish` rewrites the launchers and
shows the changelog since the previous version. `claudio upgrade --check` only asks the
registry. Interactive commands mention a new version at most once a day; `update_check = false`
in config.toml or `CLAUDIO_NO_UPDATE_CHECK=1` turns that off.

# Changesets

Every change a user would notice gets a changeset: a small Markdown file that names the
packages it touches, the semver bump, and one or two sentences for the changelog.

```sh
pnpm changeset            # pick packages and bump, write the summary
pnpm changeset status     # what the next release will contain
```

`docs/RELEASING.md` explains how changesets become versions, changelogs and npm releases.

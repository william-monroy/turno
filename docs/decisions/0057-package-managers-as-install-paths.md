# 0057. npm, pnpm, bun, yarn and Homebrew as first-class install paths

Date: 2026-11-18. Status: accepted. Builds on ADR 0007 (versions and updates), ADR 0019 (lean
install and the published shrinkwrap) and ADR 0045 (`loadOptional`).

## Context

The README and the docs listed npm and Homebrew; the docs' install tabs also showed pnpm, bun
and yarn, but nothing installed turno that way, and `turno upgrade` guessed the package manager
from words in the install path. Measured with npm 12, pnpm 12.2, bun 1.3 and yarn 1.22, each
into a throwaway prefix:

- **pnpm 11 and later install every global package in a group of its own**
  (`$PNPM_HOME/global/v11/<group>/node_modules`). A `turno-browser` added with its own
  `pnpm add --global` is neither next to `turno-cli` nor in npm's global folder, so
  `turno browser` said it was not installed. pnpm 12 also refuses a bare tarball path in a global
  add (it needs `name@file:<path>`), and `pnpm dlx` keeps its copy under `.pacquet`.
- **A custom prefix hid the package manager.** With `BUN_INSTALL` or `yarn --global-folder`
  pointing elsewhere, the path has no `.bun` or `yarn` in it, and `turno upgrade` offered
  `npm install --global`.
- **One-off runs were treated as installs.** `pnpm dlx` and `bunx` copies were detected as pnpm
  and npm, so `turno upgrade` would install turno globally instead of saying the next run gets
  the newest release, and the guard that keeps launchers from pointing into npx's cache did not
  cover them.
- **Only npm reads `npm-shrinkwrap.json`.** pnpm, bun and yarn install the exact direct
  dependencies but resolve the transitive ones themselves. Homebrew runs npm, so it reads it.

## Decision

- **Detection by lockfile first.** `detectInstall` looks at the folder that holds the outermost
  `node_modules` of the running package: `bun.lock` or `bun.lockb` is bun, `yarn.lock` is yarn,
  `pnpm-lock.yaml` is pnpm, wherever a custom prefix put it. The path rules stay as the fallback,
  then npm. One-off runners come first and are methods of their own: `npx` (`_npx`), `pnpm-dlx`
  (`pnpm/dlx/...`) and `bunx` (`bunx-<uid>-...`). For them `turno upgrade` prints the runner's
  `@latest` command and how to install turno, and changes nothing; `turno version` names the
  runner; launchers and the status line refuse to keep a path into any of their caches.
- **`turno-browser` in pnpm's groups.** `loadOptional` with `global` looks in every
  `global/v<N>/<group>/node_modules` next to turno's own group before npm's global folder.
- **CI installs it every way.** The `install` workflow packs both packages like a release, then
  on Ubuntu and macOS installs them with npm, pnpm, bun and yarn into throwaway prefixes and runs
  turno-cli once with npx, pnpm dlx and bunx (`scripts/install-smoke.sh`, which also runs
  locally). Each run checks `turno --version`, `turno doctor --summary`, the method
  `turno upgrade` detects and the command it would run, and that turno finds `turno-browser`
  installed next to it.
- **Docs say what each path gives.** The README and the install page list every package manager
  and the one-off runners, and say that only npm and Homebrew install the tested transitive tree
  from the shrinkwrap, that pnpm 11 and later wait a day before a new release
  (`minimumReleaseAge`), and that yarn means yarn 1.

## Consequences

- A pnpm, bun or yarn user can get transitive versions CI did not test. The direct
  dependencies are still exact, and nothing in the tree runs an install script (ADR 0019), so the
  exposure is the code of a newer transitive release, not a script at install time.
- A project-local install inside a folder with a `yarn.lock` is reported as yarn. turno is meant
  to be installed globally; `turno upgrade` then suggests `yarn global add`, which is harmless.
- The workflow adds two jobs per pull request, about two minutes each.

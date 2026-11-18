# 0053. turno-core: one published package for paths, the secret store and process helpers

Date: 2026-11-18. Status: accepted. Stage 5 of the wave 7 architecture review; builds on
ADR 0018 (the Secret Service), ADR 0019 (the lean install and the published shrinkwrap) and
ADR 0047 (cross-package contracts).

## Context

turno-cli and turno-browser are separate packages (ADR 0019): a user installs the browser on
its own, and turno-cli loads it only when a `turno browser` command runs. Each package kept its
own copy of what both need:

- **Paths.** `packages/browser/src/paths.ts` derived HOME, the XDG variables and the `TURNO_*`
  overrides "exactly like `turno/src/core/paths.ts`", by hand, with a comment asking to keep
  the two in step.
- **Process helpers.** `pidAlive` existed four times (`core/fsutil.ts` in the CLI, and
  `identities.ts`, `runtime-lock.ts` and `lifecycle.ts` in the browser), and the browser's
  process table reader (PID, parent, process group, command) was private to `lifecycle.ts`.
- **The secret store** lived only in the CLI (`core/secrets.ts`). The next browser feature, a
  credential vault per identity, needs the same Keychain and Secret Service code inside
  `turno-browser-mcp`, which runs without turno-cli.

turno-browser cannot import turno-cli (the CLI is the one that loads the browser, and the
browser must work without it), so the shared code needs a package of its own.

## Decision

**A new published package, `turno-core`** (`packages/core`; the name was free on npm on
2026-11-18), with no dependencies and three entry points:

- `turno-core/paths`: `turnoRoots(env)` (home, config, state, data from HOME, XDG and
  `TURNO_*_DIR`), `browserPaths(env)` (the browser's folders), the private folder and file
  helpers (`ensurePrivateDir`, `writePrivateFile`, modes 0700 and 0600) and `findOnPath`.
- `turno-core/secrets`: the `SecretStore` (`security` on macOS, `secret-tool` on Linux) moved
  as it was: values on stdin, never in argv, the same item names and attributes, the same
  errors. Tests never reach a real store: every package's test setup puts `security` and
  `secret-tool` stand-ins that refuse first on PATH, and tests that need a store use the
  file-backed fake. A test against a temporary keychain file was tried and dropped: replacing
  an item there opened a macOS SecurityAgent dialog that blocked the whole login session until
  a person dismissed it.
- `turno-core/process`: `pidAlive`, `signalProcess`, `parseProcTable`, `readProcTable` and
  `parentIsInit`.

`turno-core` (the index) re-exports all three. The CLI imports the subpaths, so `turno --help`
and the status line load one small module more, not the secret store (the lazy import test
still passes). The CLI keeps its own modules as thin re-exports (`core/paths.ts`,
`core/secrets.ts`, `core/fsutil.ts`), so no command changed an import; what is only the CLI's
(`paths()` with every CLI file, `keychain:` and `${VAR}` resolution) stays in the CLI.

**Dependencies.** turno-cli and turno-browser depend on `"turno-core": "workspace:*"`. pnpm
publishes that as the exact version, so the "exact versions only" rule of ADR 0019 holds.
turno-browser stays optional for turno-cli: it is still only a dev dependency there.

**Shrinkwrap.** `scripts/shrinkwrap.mjs` reads the manifest as pnpm publishes it
(`publishedManifest`: `workspace:*` becomes the sibling's version) and adds turno-core to each
`npm-shrinkwrap.json` with its version and registry URL but no `integrity`: the tarball of a
sibling released in the same run does not exist when the dependent's `prepack` writes the
file, and a guessed hash would break every install. npm accepts an entry without integrity and
fetches that exact version; versions on npm are immutable and turno-core is published with
provenance like the others. `pack-check` and `shrinkwrapProblems` accept the missing integrity
only for a package of this workspace; every registry package still needs its sha512.

**Release order.** `scripts/release-plan.mjs` lists each package after the workspace packages
it depends on (`publishOrder`), so the publish job, which stops at the first failure, publishes
turno-core before turno-browser and turno-cli. A cycle fails the build job.

**Trusted publishing.** A new package needs its own trusted publisher on npmjs.com, and npm
only offers that page for a package that exists. The first version of turno-core is therefore
published by the owner by hand, before the release that first depends on it; the steps are in
[RELEASING.md](../RELEASING.md#a-new-package).

## Consequences

- One place for the paths, the store and the process helpers; the copies are gone.
  `turno-browser` still exports `paths` (now `browserPaths` from turno-core) for API users.
- A turno-core release that changes behavior reaches both packages; Changesets bumps the
  dependents (`updateInternalDependencies: patch`), so they release together.
- A global install of turno-browser next to turno-cli holds two copies of turno-core, one per
  package, possibly of different versions. They share no state at run time; each only reads
  the same files and secret store.
- `pnpm build` builds turno-core first (pnpm runs the workspace in dependency order); the
  typecheck of the other packages needs that build, as it already needed turno-browser's.
- Not done: moving more of the CLI's `core/` (journal, state files) into turno-core. They have
  one user today.

---
"turno-cli": patch
---

pnpm, bun and yarn are first-class install paths. `turno upgrade` and `turno version` recognize
them from their lockfile even under a custom `PNPM_HOME`, `BUN_INSTALL` or yarn global folder,
and treat `pnpm dlx` and `bunx` like `npx`: a one-off copy has nothing to upgrade, and
`turno upgrade` says which command runs the newest release instead of installing turno globally.
Launchers and the status line refuse to point into any of those caches. `turno browser` and
`turno identity` find a `turno-browser` that pnpm 11 or later installed in its own global group.

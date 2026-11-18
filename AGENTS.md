# turno: rules for agents working in this repository

Start with the public docs: `CONTRIBUTING.md` for the setup and the rules for changes,
`docs/` and `apps/docs` for how turno works, `SECURITY.md` for what it stores and how releases
are built.

## Hard rules

- English everywhere in the repository: code, comments, CLI output, docs, commits. The
  only Spanish is `README.es.md` and the `*.es.mdx` pages of the docs site.
- Never use the em dash character (U+2014). `pnpm check` fails if one appears.
- Conventional Commits (`feat(mcpd): ...`, `fix(cli): ...`). No `Co-Authored-By`, no
  `Generated with`, no attribution trailers of any kind. The only author is the owner.
- No personal data in the repository: no real emails, profile names of the owner, paths
  under a real home, tokens. Use examples like `work`, `personal`, `alice@example.com`.
- Local only: do not add a git remote or publish packages unless the owner asks.
- Never touch the live setup of the machine (`~/.local/bin/claudio*`, `~/.claude*`, `~/.codex*`, `~/.config/claudio`, `~/.config/turno`,
  LaunchAgents) from tests. Tests run with a sandbox `HOME` (see `test/helpers`).
- Secrets come from the secret store (macOS Keychain, Linux Secret Service) at use time. Never
  log them, never write them to disk except the gateway tokens: the master token
  (`mcpd.token`) and the per-profile token files (`mcpd-tokens/<profile>.token`), mode 600.

## Workflow

- `pnpm install`, `pnpm build`, `pnpm test`, `pnpm check` (typecheck, lint with Biome and knip,
  tests, em dash scan, licenses). `pnpm test:e2e` also runs the end-to-end test that needs the
  network.
- Write the test first for behavior changes. Integration tests for mcpd use the fixture
  server in `packages/turno/test/fixtures/`.
- The repository holds only what users and contributors need. Design notes, status reports
  and decision records stay out of it; explain the reason for a non-obvious choice in a short
  code comment or in the public doc it affects.
- A user-visible change adds a changeset (`pnpm changeset`); see `docs/RELEASING.md`.
- A new agent is one adapter file in `packages/turno/src/agents/` plus tests;
  commands read adapter fields instead of branching on the agent id.
- New commands go in `cli/registry.ts`; keep old names as aliases there. Writes to user files go
  through `core/journal.ts` so `turno undo` can revert them. Read commands take `--json`,
  write commands take `--dry-run` (shared flags in `cli/args.ts`).
- The docs site is `apps/docs`. Its reference and troubleshooting pages are
  generated: after changing a command's help, a config or `mcp.toml` key, an exit code or a
  doctor check, run `pnpm build && pnpm docs:generate` and commit the result (a new doctor
  warning or failure also needs an entry in `apps/docs/reference/doctor-checks.mjs`).
  `pnpm docs:check` runs what the `docs` workflow runs; `pnpm docs:dev` previews the site.

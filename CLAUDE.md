# claudio: rules for agents working in this repository

Read `docs/STATUS.md` first: it says what is done, what is in progress and what is next.
The design lives in `docs/design/`, and every non-obvious choice is recorded in
`docs/decisions/` (one short ADR per decision).

## Hard rules

- English everywhere in the repository: code, comments, CLI output, docs, ADRs, commits.
- Never use the em dash character (U+2014). `pnpm check` fails if one appears.
- Conventional Commits (`feat(mcpd): ...`, `fix(cli): ...`). No `Co-Authored-By`, no
  `Generated with`, no attribution trailers of any kind. The only author is the owner.
- No personal data in the repository: no real emails, profile names of the owner, paths
  under a real home, tokens. Use examples like `work`, `personal`, `alice@example.com`.
- Local only: do not add a git remote or publish packages unless the owner asks.
- Never touch the owner's live setup (`~/.local/bin/claudio`, `~/.claude*`, `~/.config/claudio`,
  LaunchAgents) from tests. Tests run with a sandbox `HOME` (see `test/helpers`).
- Secrets come from the macOS Keychain at use time. Never log them, never write them to disk
  except the mcpd bearer token (mode 600).

## Workflow

- `pnpm install`, `pnpm build`, `pnpm test`, `pnpm check` (typecheck + tests + em dash scan).
- Write the test first for behavior changes. Integration tests for mcpd use the fixture
  server in `packages/claudio/test/fixtures/`.
- Record decisions as ADRs (`docs/decisions/NNNN-title.md`: context, decision, consequences).
- Update `docs/STATUS.md` at the end of each work session.
- A user-visible change adds a changeset (`pnpm changeset`); see `docs/RELEASING.md`.
- New commands go in `cli/registry.ts`; keep old names as aliases there. Writes to user files go
  through `core/journal.ts` so `claudio undo` can revert them. Read commands take `--json`,
  write commands take `--dry-run` (shared flags in `cli/args.ts`).

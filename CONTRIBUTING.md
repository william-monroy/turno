# Contributing to turno

Thanks for helping. turno is maintained by one person, so the process below exists to keep
review time for the changes that matter. Read [GOVERNANCE.md](GOVERNANCE.md) for how decisions
are made and [AI_POLICY.md](AI_POLICY.md) if you use AI tools.

## What is welcome

- **Bug reports** with the issue form: version, OS, Node, which package, which agent.
- **Fixes** for an open, confirmed bug: open the pull request and link the issue.
- **Docs**: typos, unclear steps, missing examples. No issue needed.
- **Features, new agents, new commands, config keys**: open an issue first and wait until it
  is labeled `accepted`. Large changes (a new agent adapter, a change to the config format, the
  security model, or anything that breaks a command) go through an `rfc` issue and end in an
  ADR in `docs/decisions/`. A pull request for a feature without an accepted issue may be closed
  without review; that is about time, not about the idea.

## Set up

Requirements: Node 22.11 or newer, pnpm (the version in `package.json` `packageManager`;
`corepack enable` picks it up), macOS or Linux.

```sh
pnpm install
pnpm hooks              # commit-msg hook: Conventional Commits, no attribution trailers
pnpm build
pnpm test               # unit and integration tests, with a sandbox HOME
pnpm check              # typecheck, tests, repository text rules, dependency licenses
```

Tests never touch your real setup: they run with a temporary `HOME` (see
`packages/turno/test/helpers`). Keep it that way in new tests. The end-to-end test drives a
signed-in `claude`; set `TURNO_SKIP_E2E=1` to skip it.

The three packages:

| Package | Path | What |
|---|---|---|
| `turno` | `packages/turno` | the CLI, the MCP gateway (`mcpd`), the status line, the accounts bridge |
| `turno-browser` | `packages/browser` | the persistent-profile browser MCP server (optional) |
| `turno-fonts` | `packages/fonts` | the status line font (optional) |

## Rules for changes

- **Tests first** for behavior changes. Integration tests for the gateway use the fixture
  server in `packages/turno/test/fixtures/`.
- **English** in code, comments, CLI output and docs. No em dash character anywhere
  (`pnpm check` fails on one).
- **Commands**: new commands go in `cli/registry.ts`; renamed commands keep the old name as an
  alias. Read commands take `--json`, write commands take `--dry-run`, and every write to a
  user file goes through `core/journal.ts` so `turno undo` can revert it.
- **Changesets**: a change a user would notice adds one (`pnpm changeset`). CI asks for it when
  a pull request touches `packages/*/src`. See [docs/RELEASING.md](docs/RELEASING.md).
- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) in English
  (`feat(mcpd): ...`, `fix(cli): ...`). Pull requests are squash-merged, so the pull request
  title must follow the same format.
- **Sign-off**: add `Signed-off-by: Your Name <you@example.com>` (`git commit -s`) to certify
  the [Developer Certificate of Origin](https://developercertificate.org/): you wrote the change
  or have the right to submit it under the project license (Apache-2.0).
- **No attribution trailers** for tools: no `Co-Authored-By` for AI assistants, no "Generated
  with" lines. The commit hook rejects them. AI use is declared in the pull request template
  instead (see [AI_POLICY.md](AI_POLICY.md)).
- **No personal data**: no real emails, account names, tokens or paths under a real home in
  code, tests or fixtures. Use `work`, `personal`, `alice@example.com`.

## Reporting security issues

Never in a public issue. See [SECURITY.md](SECURITY.md).

## Code of conduct

Everyone in the project's spaces follows the [Code of Conduct](CODE_OF_CONDUCT.md).

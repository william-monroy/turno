# 0046. A documentation site, with a reference generated from the code

Date: 2026-11-17. Status: accepted.

## Context

The docs were one long README (with a shorter Spanish one), BENCHMARKS.md, SECURITY.md and
`docs/*.md`. That is enough for someone who already uses turno, but a new reader has to find the
part that answers their problem inside 400 lines, and the reference tables in the README are
written by hand, so they drift from the CLI: while this was built, `docs/mcp.md` turned out not
to show three keys a profile variant accepts (`command`, `args`, `cwd`).

## Decision

**A private workspace app, `apps/docs`, built with Fumadocs (Next.js).** It is never published
to npm, and every dependency is a devDependency, so `pnpm licenses list --prod`
(THIRD_PARTY_NOTICES.md) and the published packages do not see it. The root `build`,
`typecheck` and `test` scripts cover `packages/*` only; the site has `pnpm docs:dev`,
`docs:build`, `docs:generate`, `docs:check` and `docs:tapes`. It is meant for
`https://turno.wimo.dev`; deploying it is a separate step.

**Structure.** Get started (what turno is in one diagram, try it, install, first five minutes),
guides by problem, concepts, reference, troubleshooting, security and privacy, benchmarks,
comparison, FAQ. English at the root; Spanish (Mexico) under `/es` for Get started and the FAQ
only, and every other page falls back to English. This is the one place besides `README.es.md`
where the repository holds Spanish.

**The reference and the troubleshooting pages are generated**
(`apps/docs/scripts/generate.mjs`, `pnpm docs:generate`) and committed:

- commands: the registry (`cli/registry.ts`) and the text of `turno <command> --help`, run from
  the built CLI in a throwaway HOME with a fixed width and no colors;
- `config.toml`: `turno config --help`, checked against `KNOWN_KEYS` in `core/config.ts`;
- `mcp.toml`: the annotated block in `docs/mcp.md`, checked against the keys the parser in
  `core/manifest.ts` reads, in both directions;
- environment variables, exit codes and the `--json` contract: `turno help <topic>` and
  `cli/exit.ts`;
- troubleshooting: every warning and failure that `turno doctor`, `turno doctor --security` and
  `turno browser doctor` can report, read from the TypeScript source with the compiler API.

Doctor checks have no id in the code, so `apps/docs/reference/doctor-checks.mjs` gives each one
a stable id (the page slug), a title and why it happens, matched by a fragment of its text. The
generator fails when a finding in the code has no entry, an entry matches nothing, or two
match, so a new check cannot ship without its page.

**One route tree per language, no middleware.** English lives in `app/(en)` and Spanish in
`app/es`, each with its own root layout, and both render the same components
(`components/routes`). Hiding the default language with a middleware rewrite made the server
render `/en/docs/...` while the browser was at `/docs/...`, so the sidebar's active link and the
page's table of contents failed to hydrate.

**CI.** `.github/workflows/docs.yml` runs only when the site, `docs/`, or `packages/*/src`
change: it regenerates the pages and fails on a difference, builds the site, and checks every
internal link, anchor and image of the built site (`scripts/check-links.mjs`). The main `ci` workflow
is unchanged.

**Terminal recordings as text.** The tapes in `apps/docs/tapes` start in the clean shell of
`docs/demo/setup.sh` and run `turno demo` (ADR 0041), and write the terminal as text;
`scripts/render-tapes.mjs` keeps the last frame, so the site shows output that can be selected
and copied. Ports, pids and times differ between runs, so the files in `content/recordings` are
committed, and CI renders the tapes to prove they still run and uploads the result.

**For agents.** `/llms.txt`, `/llms-full.txt`, and every page as Markdown at its URL plus `.md`,
which is also what the "Copy Markdown" button copies.

## Consequences

- A change to a command's help, a config key, an exit code or a doctor check needs
  `pnpm build && pnpm docs:generate`; the `docs` workflow says so when it is forgotten.
- A stable `id` on each doctor check in the code (and in `--json`) would replace the catalog's
  text matching. Until then, rewording a check means updating its `match`.
- The README stays as it is for now, with a link to the site at its end.
- The site copies its images from `docs/assets` at build time, so the repository keeps one copy.

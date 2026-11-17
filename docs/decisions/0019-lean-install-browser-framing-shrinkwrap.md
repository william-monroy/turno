# 0019. A lean default install, the browser as a developer diagnostic, and a published shrinkwrap

Date: 2026-11-16. Status: accepted.

## Context

Three findings of the 2026-11 audit touch how turno is packaged:

- `turno-cli` listed `turno-browser` and `turno-fonts` as `optionalDependencies`, so
  `npm install --global turno-cli` also downloaded a browser automation engine
  (`patchright-core`) and 11 MB of fonts that most users never use. Measured with npm 11.20 into
  an empty prefix: 0.1.1 from the registry is 51.5 MiB and 100 packages.
- `turno browser` described itself as showing "how automation-fingerprint test pages see each
  browser engine", its usage named engines and "bot detectors", `browser bench --json` opened
  Chrome on third-party pages without asking, and `turno-browser-mcp --identity <id> --port <n>`
  served a signed-in browser over HTTP to any local process. The plugin descriptions put "usage
  limit" and "hands a session over to another profile" in one sentence (ADR 0012 draws that line).
- `turno-cli` pins its direct dependencies, but the MCP SDK declares ranges, and no lockfile was
  published: `npm install --global` and the Homebrew formula resolved about 95 transitive
  packages at install time, outside the review and the release age that CI applies.

## Decision

**Optional packages out of the default install.** `turno-browser` and `turno-fonts` are no
longer dependencies of `turno-cli` (they stay as `workspace:*` dev dependencies for the tests).
`turno ui install` downloads the four MesloLGS files from the Nerd Fonts v3.4.0 tag and refuses
any file whose SHA-256 differs from the pinned value (`ui/fonts.ts`, unchanged; verified end to
end from a packed install). `turno browser` and `turno identity` say
`turno-browser is not installed: npm install --global turno-browser`; they also find the package
in the global npm folder, so a Homebrew or npx install of turno can use a separately installed
`turno-browser`. Measured the same way after the change: 27.1 MiB and 97 packages.

**Browser framing.** `turno browser` is described as a developer diagnostic for browser engine
compatibility. Its help names no engines, detectors or evasion; `bench` asks
`This opens Chrome and visits third-party test pages. Continue? [y/N]` in a terminal, refuses
without a terminal unless `--yes` is given, and `--json` is not consent. `--only-urls` replaces
`--no-detectors` (kept as a hidden alias). Both commands use the shared strict flag parser, so
`--help` works everywhere and unknown flags are errors. `turno-browser-mcp` refuses `--port` or
`--host` together with `--identity` unless `--allow-http-identity` is given; even then it binds
to 127.0.0.1, rejects any non-loopback `--host` and `--allowed-hosts '*'`, and keeps Playwright
MCP's Host header check. Internal engine names (`patchright-*`, `camoufox`) and ADR 0005 keep
their words: they record what was built and measured. (ADR 0041 later renamed the engine ids to
`chrome-headed`, `chrome-headless`, `chrome-baseline` and `firefox`, keeping the old ones as
aliases; ADR 0005 is unchanged.)

**Plugin wording.** The plugin, hook and marketplace descriptions state separately that a
status hook records each profile's reset time for `turno status`, and that two skills print the
command to resume or fork a session under a profile the user picks. Behavior is unchanged.

**Published shrinkwrap.** `scripts/shrinkwrap.mjs` writes `npm-shrinkwrap.json` for
`turno-cli` and `turno-browser` in their `prepack`, so every `pnpm pack` (pack-check, the release
build) produces it. It is derived offline from the pnpm install (each package's resolved
dependencies, peers included) and the integrity values in `pnpm-lock.yaml`, laid out the way npm
lays out `node_modules` (hoisted, nested only on a version conflict). Published dependencies stay
exact versions. `scripts/pack-check.mjs` fails when a published package has a dependency that is
not an exact version, when the shrinkwrap is missing from the tarball or differs from what the
lockfile and installed tree give, when `npm ls --package-lock-only` reports a missing or invalid
edge, or when anything in the published tree has an install script (`preinstall`, `install`,
`postinstall`, or a `binding.gyp`). That last check backs the README claim of zero install
scripts. `release-plan.mjs` refuses a tarball with dependencies and no shrinkwrap.

**Release egress.** The `publish` and `tag` jobs run Harden-Runner with `egress-policy: block`
and an allow list taken from the audit log of the 0.1.1 release run (npm registry, GitHub API
and uploads, Sigstore Fulcio, Rekor and TUF, and the hosts `setup-node` uses when Node 24 is not
cached). Harden-Runner adds the Actions service hosts itself (`*.actions.githubusercontent.com`,
`productionresultssa*.blob.core.windows.net`). The other jobs stay in audit mode.

## Where npm honors the shrinkwrap (verified with npm 11.20)

- **From the registry** (`npm install --global turno-cli`, `npx turno-cli`): honored. The
  registry marks a version that ships `npm-shrinkwrap.json` with `_hasShrinkwrap`, and npm then
  installs the locked tree without resolving anything. Checked with a local one-package registry
  serving the packed tarball (other packages proxied to registry.npmjs.org): all 96 locked
  entries installed at the locked version, including three where a newer version exists.
- **From a local tarball** (`npm install --global ./turno-cli-x.tgz`): ignored. npm strips
  underscore fields from a tarball's manifest, so it never sees `_hasShrinkwrap` and resolves
  the ranges again (three packages came out newer than locked). This is the path Homebrew's
  `std_npm_args` takes. The formula should install the extracted tarball with the lockfile
  instead, which installs exactly the locked tree:

  ```ruby
  def install
    system "npm", "pkg", "delete", "devDependencies"
    system "npm", "ci", "--omit=dev", "--ignore-scripts"
    libexec.install Dir["*"]
    bin.install_symlink libexec/"dist/cli/main.js" => "turno"
  end
  ```

  `npm ci` refuses the published `package.json` as is, because its `devDependencies` are not in
  the shrinkwrap; deleting them first is safe (nothing at run time reads them).
- **pnpm, Yarn and Bun** ignore `npm-shrinkwrap.json` of a dependency.

## Consequences

- A user who wants the fonts offline, or the browser, installs `turno-fonts` or
  `turno-browser` explicitly. Docs that say "optional dependency" change to "separate package".
- Dependabot pull requests that only change `pnpm-lock.yaml` need nothing else: the shrinkwrap
  is regenerated at pack time and pack-check compares it with the lockfile.
- A new dependency with an install script, or a dependency added with a range, fails CI.
- If the publish job ever needs a new host, it fails with a Harden-Runner annotation naming the
  host; add it to the allow list in `release.yml`.

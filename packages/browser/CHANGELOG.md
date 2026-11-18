# turno-browser

## 0.2.0

### Minor Changes

- c0b33e0: Neutral engine ids for `turno browser bench`, and a README demo of the current CLI.
  
  - `turno browser bench` names its engines by browser and mode: `chrome-headed`,
    `chrome-headless`, `chrome-baseline` and `firefox`. The old ids (`patchright-chrome-headed`,
    `patchright-chrome-headless`, `playwright-stock`, `camoufox`) are still accepted by `--engine`,
    and the report (table and `--json`) uses the new ones. turno-cli keeps working with an older
    turno-browser.
  - `turno doctor` and the status screen recognize turno's own status line when its path is
    quoted (as `turno demo` writes it), and show any other status line command without quotes,
    with ~ for your home folder and cut to fit the row.
  - The README demo is recorded from `turno demo` in a throwaway HOME and shows the status screen,
    `turno init --dry-run`, profiles, the profile picker, `turno doctor` with its fix lines,
    `turno mcp list` and `turno limit show`.
- b3cfa89: A lighter default install and a locked dependency tree.
  
  - `npm install --global turno-cli` no longer pulls in `turno-browser` and `turno-fonts`
    (about 52 MB down to 27 MB). `turno ui install` downloads the status line font and checks
    each file against its pinned SHA-256. Install the browser package yourself when you want it:
    `npm install --global turno-browser`; `turno browser` and `turno identity` say so when it is
    missing, and find it in the global npm folder.
  - `turno-cli` and `turno-browser` ship an `npm-shrinkwrap.json`, so an install from npm gets
    exactly the dependency versions that were tested. No package in either tree runs an install
    script, and CI checks it.
  - `turno browser` is a developer diagnostic for browser engine compatibility. `browser bench`
    asks before it opens Chrome on third-party test pages, and without a terminal it needs
    `--yes` (`--json` alone no longer runs it). `--only-urls` replaces `--no-detectors`, which
    still works. `turno browser` and `turno identity` accept `--help` after any subcommand and
    reject unknown flags.
  - `turno-browser-mcp` refuses `--port` or `--host` together with `--identity`, which would
    serve a signed-in browser over HTTP; pass `--allow-http-identity` to accept that, and it then
    listens on 127.0.0.1 only.
  - An empty `turno identity` suggests `turno identity add ...` instead of the old
    `turno accounts add ...`.

## 0.1.1

### Patch Changes

- 35a3c4a: The README links to the `turno-cli` package, the name the CLI is published under.
- ce52d03: The repository moved to `github.com/wimo-dev/turno`. turno-browser is listed in the MCP
  Registry as `io.github.wimo-dev/turno-browser`.

## 0.1.0

First public release: an MCP server that drives your installed Google Chrome with a persistent
profile per identity (`turno-browser-mcp --identity <name>`), headed by default, plus the
`turno browser bench` checks.

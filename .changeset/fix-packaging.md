---
"turno-cli": minor
"turno-browser": minor
---

A lighter default install and a locked dependency tree.

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

# 0041. The README demo records `turno demo`, and bench engines get neutral ids

Date: 2026-11-17. Status: accepted.

## Context

The README gif came from a tape with its own setup: a hand-made HOME, a copied `mcp.toml` with
servers that were never started, and a gateway launched in the background. It showed commands
from before the status screen, the picker and the doctor fix lines, so it drifted from the CLI
with every release. It also ran in the shell VHS starts, which inherits the recording person's
environment (PATH, agent variables, the version manager under their HOME).

`turno browser bench` named its engines after the libraries behind them (`patchright-*`,
`playwright-stock`, `camoufox`). ADR 0019 kept those words as internal names, but the ids appear
in `--engine`, in the table and in the JSON report, so users see them.

## Decision

**Demo.** `docs/demo/setup.sh` replaces the VHS shell (`exec`) with a bash that has an empty
environment: a throwaway HOME, a PATH with only the system folders and a `turno` that runs the
checkout, `USER=demo`, and a copy of node under `/tmp/turno-vhs` so the MCP server command that
`turno mcp list` prints is not a path under a real HOME. In it the tape types `turno demo`, which
builds the profiles, folder rule, gateway and servers, opens a shell, and removes all of it when
the tape types `exit`. The tape then shows the status screen, `turno init --dry-run`,
`turno profile list`, the picker (through `turno profile assign`), `turno doctor`, `turno mcp list`
and `turno limit show`.

A README gif has to show turno working, so the recording shows signed-in accounts and usage
without a real agent or login. The `claude` on that PATH is a stand-in written by setup.sh: it
answers `claude auth status --json` for two example accounts (`you@personal.example`,
`you@work.example`) by the profile's `CLAUDE_CONFIG_DIR`, and `--version`, and refuses anything
else, so no profile can start an agent through it. A hidden `turno-demo-seed` step writes usage
snapshots in the shape the status line records them (`state/usage/<profile>.json`) and copies
the bundled font into the demo HOME's font folder; it does not run `turno ui install`, which can
change terminal settings outside HOME.

The picker is shown through `turno profile assign` and not `turno run`: choosing a profile in
`turno run` starts the agent, which in the recording either is missing (the launcher's error) or
is the real agent with a fresh config folder (its first-run screens, and a credential lookup in
the secret store).

**Engine ids.** The engines are `chrome-headed`, `chrome-headless`, `chrome-baseline` (stock
Playwright with Chrome, the comparison point) and `firefox`. `ENGINE_ALIASES` and `engineId()`
in turno-browser map the old ids to the new ones, and turno-cli asks the package to resolve a
name when it can, so `--engine patchright-chrome-headless` keeps working and an older
turno-browser (no `engineId`) still gets the names it knows. This replaces the sentence in ADR
0019 that kept the internal engine names.

## Consequences

- Regenerating the gif needs only `pnpm build && vhs docs/demo/demo.tape`; the recording follows
  `turno demo`, so a change to the demo shows up in the next recording.
- The accounts and usage in the gif come from the stand-in and the seed step. The personal
  profile is seeded with the numbers of `turno demo`'s sample status line (38% and 12%), so the
  intro and the status screen agree.
- Recording the demo showed that `turno demo` writes its status line command with a quoted path,
  which turno did not recognize as its own: doctor and the status screen printed the raw command.
  `isTurnoStatusLine` now accepts a quoted path, and `statusLineLabel` shows any other command
  without quotes, with ~ for HOME, cut to the row.
- Bench reports written before this change carry the old ids; nothing reads them back.

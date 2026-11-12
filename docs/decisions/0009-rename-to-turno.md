# 0009. The project is called turno

Date: 2026-11-12. Status: accepted.

## Context

The npm names `claudio` and `claudio-cli` are taken, `ccode` and `ccode-cli` too (and five
packages install a `ccode` command). A name close to "Claude" also invites trademark trouble
once the project is public, and the tool may grow beyond Claude Code.

## Decision

- The project, the npm package and the command are `turno`: each account takes its turn, and
  another takes over when one runs out. The optional packages are `turno-browser` (command
  `turno-browser-mcp`) and `turno-fonts`, unscoped so no npm organization is needed.
- Paths follow: `~/.config/turno`, `~/.local/state/turno`, `~/.local/share/turno`, environment
  variables `TURNO_*`, the LaunchAgent `dev.turno.mcpd`, Keychain items `turno/<server>/<key>`,
  launchers `turno-auto` and `turno-open`, the Claude Code plugin `turno`.
- The bash tool keeps its name in everything that reads it: `~/.config/claudio` (`proyectos`,
  `navegador`, `run`, `uso`, `chrome`) is what `turno migrate` imports, and the bash launchers
  `claudio-auto` and `claudio-navegador` are rewritten to run turno, so Orca and open sessions
  keep working through the cutover. Its Spanish command words stay as aliases.
- ADRs 0001 to 0005 and the design document keep the old name: they record what was decided
  then.

## Consequences

- No user had the TypeScript claudio installed, so nothing migrates from `~/.config/claudio`
  besides the bash config. At the cutover `~/.local/bin/claudio` becomes a link to `turno`.

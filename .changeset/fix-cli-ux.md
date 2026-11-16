---
"turno-cli": minor
---

First-run fixes for the command line.

- `turno auto` never switches accounts in silence: a missing launcher, a rule naming a missing profile or a broken `config.toml` stop it with exit 1 and the command that fixes it (`TURNO_ALLOW_PLAIN=1` runs the plain agent despite a broken config). `system = ""` means "no default account": folders without a rule are an error too. `turno auto --agent codex` says when it runs plain `codex`.
- `turno profile which` and `turno status` show the folder's profile for every agent with profiles.
- `turno config set` checks values the way `profile add` does (profiles must exist and run the right agent, colors and enums must be valid; exit 2), and `config set fallback` reminds that the fallback is opt-in. `config.toml` errors show `~` paths and explain an unclosed string. Unknown keys and rules or roles that name missing profiles are listed by `turno doctor` and `turno config check`, with a suggestion for typos. New keys `agents.<agent>.default` and `agents.<agent>.fallback`.
- Typos: `turno --verison` is an unknown option, `turno stauts` suggests `turno status`, `turno profile lst` suggests `turno profile list`.
- One help path: `turno <command> --help`, `turno <command> <sub> --help` and `turno help <command> [sub]` print the usage on stdout with exit 0, and `--help` anywhere never runs the command. Help wraps at 80 columns. The main help starts with what turno is and a "Start here" line; `migrate` and the older names are hidden (they still work), and `browser` moved to a "Developer tools" section. `turno ui` is a regular command group (`turno ui install --help` works).
- Launchers stop with `turno: claude is not installed (...)` when the agent is missing, export `BROWSER` only where `turno-open` can work (macOS, or Linux with `xdg-open`), and point at the `turno` on your PATH when there is one. Running from npx's cache, commands that would write its path (`profile add`, `profile repair`, `ui install`) refuse and ask you to install turno first.
- `profile add` and `doctor` warn when `~/.local/bin` is not on your PATH, with the line to add, and suggest `turno <name>` meanwhile. `doctor` lists all four agents and fails only for one a profile uses; `profile add --agent X` warns when X is not installed.
- `profile add` and `profile repair` print one summary line for the shared folders (`-v` lists them) and ask before moving your own files to `.aside-<time>/` (`--yes` for scripts; without a terminal they stop and say so).
- Strict flags on more commands (`session handoff`, `migrate`, `resolve`, `ui install`, identity subcommands): a mistyped flag is an error instead of being ignored. Completion of these flags comes from the same spec.
- Empty states and wording: `turno limit` with no profiles says so, profiles without data say `no usage data yet`, plurals are right.

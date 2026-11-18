---
"turno-browser": minor
"turno-cli": minor
---

Browser identity module:

- `identity.json` next to each identity's profile keeps its time zone, languages, locale and
  region fixed; Chrome gets them at every start (`--accept-lang`, `--lang`, and the time zone
  when it differs from the machine's). `turno identity add browser:<id>` pins a new identity to
  the current time zone and takes `--timezone`, `--locale`, `--languages`, `--region` and a
  health check; `turno identity show` and `turno identity set` read and change it
  (`turno browser show/set <id>` too). Without the file nothing changes.
- A runtime lock (`{ nodePid, chromePid, pgid, startedAt }`) while an identity's Chrome runs: a
  second session gets a message naming the process and how to stop it instead of "Browser is
  already in use".
- An optional session health check (a URL and a text or selector) marks a signed-out identity
  NEEDS_AUTH; tool calls then fail with a message that asks for `turno browser login <id>`.
- Each captcha, "verify it's you" or block page an identity meets is logged per site (host name
  only); `turno browser reputation [<id>] [--json]` shows counts and trend.
- `turno browser doctor [--fix] [--no-launch] [--json]`: Chrome and its version, a smoke launch,
  the desktop session, and per identity its settings, lock, sign-in and recent challenges, with
  a fix for each problem.
- mcpd: `stop_grace` per server in `mcp.toml`, the wait between closing stdin and SIGTERM;
  5 seconds by default for turno-browser-mcp, the SDK's 2 seconds for every other server.

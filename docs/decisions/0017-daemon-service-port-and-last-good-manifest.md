# 0017. mcpd as a service on macOS and Linux, a fixed port, and the last good manifest

Date: 2026-11-16. Status: accepted.

## Context

The audit of 2026-11-16 found that the daemon was the weakest part of the gateway:

- A second mcpd, or any process holding port 47821, moved the gateway to the next free port
  without a word and overwrote `mcpd.port`. Synced profiles kept the old port, so sessions sent
  the bearer token to whoever held it (another local user, in the worst case).
- An `mcp.toml` that did not validate stopped mcpd from starting, and launchd restarted it every
  ten seconds forever. `mcpd.log` grew without limit and an exception took every session down.
- The LaunchAgent ran as `Background` (macOS throttles it), pinned the nvm or Cellar path of the
  node that installed it, had no dry run, was not journaled, survived `daemon stop` (it came back
  at login) and was not rewritten by `upgrade --finish`.
- On Linux `mcp daemon start` printed `spawn launchctl ENOENT` with a stack and left
  `~/Library` behind. The client PID needed `lsof`, which many Linux hosts lack.
- The token was never rotated and its file mode never checked.

## Decision

**Service.** `mcpd/service.ts` picks a backend by platform: a LaunchAgent (`mcpd/launchd.ts`) on
macOS, a `systemd --user` unit (`mcpd/systemd.ts`, `~/.config/systemd/user/turno-mcpd.service`)
on Linux when `systemctl --user` answers, and a one-line error otherwise (`turno mcp daemon run`
still works under any supervisor). A missing `launchctl` or `systemctl` is a one-line error,
never a stack. Both backends:

- run `<program> mcp daemon run` with the caller's PATH and turno's own variables, plus
  `TURNO_MCPD_SERVICE` so the daemon knows a supervisor restarts it;
- restart only after a failure (`KeepAlive.SuccessfulExit = false`, `Restart=on-failure`), so a
  clean exit ("another mcpd already serves") does not loop; the LaunchAgent is `Interactive`;
- prefer a stable program: a `turno` on PATH that is this installation (or a Volta shim), else a
  stable node with the script. Paths under nvm, Cellar, Volta images, fnm, asdf, mise or npx
  caches are pinned only as a last resort, with a warning;
- write their file through the journal, so `turno undo` restores it. `start --dry-run` prints it.
  `stop` stops the service and removes the file (journaled), so mcpd does not return at login and
  uninstalling turno afterwards leaves nothing running. `upgrade --finish` rewrites the file and
  restarts mcpd when one is installed (open sessions reconnect on their next call).

**One instance, one port.** mcpd takes `state/mcpd.lock` with `O_EXCL` and its PID before it
listens. A lock whose PID is dead, or is not an `mcp daemon run`/`mcpd run` process (a PID reused
after a reboot), is stale and replaced. There is no port fallback: if `mcpd.port` is busy, mcpd
asks the port whether it is our mcpd (`/status` with our token), and otherwise fails naming the
owner (`/proc/net/tcp` on Linux, `lsof` elsewhere). The lock is a courtesy; binding the one port
is the real exclusion, so a race between two starters cannot produce two gateways. Under a
service a busy port does not exit (that would loop): mcpd retries every 30 seconds. The reason is
kept in `state/mcpd.error.json` until a good start. `mcpd.port` and the lock are removed on stop;
a port file without a live lock is ignored as stale. `doctor` checks that the listener answers
with our token and runs under our uid, that the service file's paths exist and are not pinned to a
version, and that synced profiles point at the port mcpd uses.

**Last good manifest.** Every load of `mcp.toml` that validates is copied to
`state/mcp.last-good.toml`. At start, a file that does not validate is replaced by that copy, or
by an empty manifest; a reload that fails keeps what runs. A broken `config.toml` gives the
defaults (keeping its `mcpd.port` when the TOML still parses). The error is logged and shown in
`/status`, `mcp daemon status` and `doctor`. mcpd never refuses to start because of a typo.

**Log and crashes.** `mcpd.log` is one append stream with an error handler, rotated at 5 MiB
(`mcpd.log.1`, `.2`). In the daemon process an unhandled rejection or a socket or disk error
(`EPIPE`, `ECONNRESET`, `ENOSPC`, ...) is logged and mcpd keeps serving; any other exception is
logged, mcpd stops cleanly and exits 1 so the service manager restarts it. Timestamps stay UTC
ISO in the file; `mcp daemon logs` shows local time (`--utc` for the raw lines).

**Token.** `masterToken()` in `mcpd/daemon.ts` is the only reader and writer of
`state/mcpd.token`. Reads `fstat` the open file: a mode wider than 600 is fixed (or reported), a
file owned by another uid is reported. Writes are atomic with mode 600. `turno mcp token rotate`
writes a new one, restarts the service (or sends SIGHUP to a hand-started mcpd, which reloads the
token and the manifest) and asks for `turno mcp sync`. The token is not journaled: a backup would
copy a secret. Per-profile tokens, when they come, derive from this master token.

**Peer PID.** On Linux the client of a connection is found from `/proc/net/tcp(6)` and
`/proc/<pid>/fd`; then `lsof`; then nothing.

## Consequences

- A busy port is now a visible failure instead of a silent token leak; users who relied on the
  fallback pick a port with `turno config set mcpd.port <port>` and run `turno mcp sync`.
- `mcp daemon stop` is permanent until the next `start`; there is no "stop until next login".
- Plists written by 0.1 (`Background`, `mcpd run`, pinned node) keep working; `doctor` flags them
  and `turno mcp daemon start` or `turno upgrade --finish` rewrites them.
- `turno undo` reverts the service file, not the service manager's state: after undoing a
  `stop`, run `turno mcp daemon start` to load it again.
- A per-installation random port (suggested by the audit) is not done; the fixed default with a
  loud failure and the doctor checks cover the same risk.

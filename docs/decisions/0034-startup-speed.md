# 0033. Startup speed: static help, light gateway state, cached account answers

Date: 2026-11-17. Status: accepted.

## Context

Every command is a lazy module (`cli/registry.ts`), but three paths still paid for code they did
not use. `turno --help` imported all twenty command modules (and with them the MCP SDK) only to
read one `summary` string from each. `turno` and `turno status` imported `mcpd/daemon.ts`, and
through it the gateway and the MCP SDK, to read the token, lock and port files; with the gateway
running they also loaded the OAuth client through `turno mcp`'s static imports. And every run of
`turno`, `turno status` or `turno profile list` started `claude auth status` once per Claude Code
profile, a full Node program each, to show the signed-in email and plan.

## Decision

**Help from data.** `HELP_SUMMARY` in `cli/registry.ts` holds the one-line summary of every
visible command; `turno help` renders from it and the `SECTIONS` order without loading a command.
A test checks that each entry equals the command's own `summary`, and another wraps the loaders
and asserts that `--help`, `-h` and `help` call none of them (a count, not a time budget, so it
does not flake on slow machines).

**Gateway state without the gateway.** `mcpd/state.ts` holds what reads the gateway's files:
`daemonFiles`, the master token, the lock, `loadConfigSafe`, `mcpdPort`, the last start error and
`answersAsMcpd`. It imports no MCP code; `daemon.ts` re-exports it, so existing callers keep
working, and the status paths import `state.ts` directly. `cli/commands/mcp-oauth.ts` loads
`mcpd/oauth.ts` (which needs the SDK) inside the functions that use it.

**Account answers cached by their files.** A successful `claude auth status --json` is kept in
`<state>/cache/auth-<profile>.json` (mode 600) for five minutes, keyed by inode, size and mtime of
the profile's `.claude.json` (where Claude Code keeps the signed-in account) and
`.credentials.json` (its token file where there is no Keychain). A login or logout rewrites one of
them and the next run asks again; the key is taken after the call, so a `claude` that touches its
own files still finds its entry. Failures are not kept. The plan file the status line reads is
written on a hit too, as before.

**Node's compile cache.** The CLI entry calls `module.enableCompileCache` (guarded for a Node
without it) before the first command loads, in `$XDG_CACHE_HOME/turno/node-compile-cache` (default
`~/.cache/turno/...`) instead of Node's default in the shared temp folder. `NODE_COMPILE_CACHE` and
`NODE_DISABLE_COMPILE_CACHE` keep their meaning. `turno demo` skips it, since it promises to leave
HOME as it found it; `turno uninstall` lists the folder among the things that stay.

## Consequences

- `turno --help` costs about what `turno --version` does; `turno` and `turno status` load no MCP
  SDK code; with slow `claude` answers they no longer wait for one per profile on every run.
- A new visible command needs its line in `HELP_SUMMARY`; the test names the one that is missing.
- If Claude Code ever kept the account somewhere else, `turno status` could show a stale account
  for at most five minutes.
- On a fast machine the compile cache is within noise; it helps slower disks and CPUs, and costs a
  few hundred KB in the user cache folder.

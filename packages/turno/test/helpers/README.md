# Test helpers

Tests never touch the real home. Two layers make sure of it:

1. **`sandbox()`** (`sandbox.ts`) gives each test a throwaway HOME and an env that holds only
   `PATH`, `HOME`, `TMPDIR` and `TURNO_NO_UPDATE_CHECK`. Pass `sb.env` to the code under test,
   never `process.env`.
2. **The global setup** (`global-setup.ts`, wired in `vitest.config.ts`) points `HOME` and the
   XDG variables of the whole run at another throwaway folder and clears the variables of a
   live session (`TURNO_*`, `CLAUDE*`, `CODEX_*`, `CURSOR_*`, `ANTHROPIC_*`). That folder stands
   for the real home: code that falls back to `process.env` or `os.homedir()` writes there, and
   when the run ends anything found in it fails the run with the list of paths.

Other helpers:

- `cli.ts`: `fakeIo(env)` records output; `fakeCommand(sb, name, script)` puts a shell script
  first on the sandbox `PATH`.
- `e2e.ts`: `realBinEnv(sb, extra)` is the env for a real agent binary (claude, codex,
  cursor-agent), built from the sandbox env; `hasBinary(cmd)` probes `cmd --version` inside a
  throwaway sandbox. `networkE2e` is true with `TURNO_E2E_NETWORK=1`.
- `fake-secret-store.ts`: `fakeSecretStore(sb)` puts file-backed `security` and `secret-tool`
  stand-ins first on the sandbox `PATH` (items under `<sandbox>/fake-secrets/`), with
  `failWrites(true)` to act like a Keychain that refuses writes. Never the real Keychain.
- `oauth-fakes.ts`: an in-process OAuth authorization server and an MCP server it protects, on
  127.0.0.1, and `approve(url)`, which plays the browser for `turno mcp login` (ADR 0029).
- `wait.ts`: `waitFor(check)` polls instead of sleeping a guessed time; `killAndWait(child)`
  for `afterEach`, so no child outlives a failed test.

## End-to-end tests

`e2e-claude.test.ts` and `e2e-agents.test.ts` run the real agent binaries when they are
installed, always with a sandbox HOME. `TURNO_SKIP_E2E=1` skips them. The Cursor test needs
Cursor's servers, so `pnpm check` skips it; run it with `pnpm test:e2e` (sets
`TURNO_E2E_NETWORK=1`).

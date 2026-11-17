---
"turno-cli": minor
---

Security checks and hardening:

- `turno doctor --security` checks who can read or write turno's folders (`--fix` narrows them
  to owner only), who holds the mcpd port, literal secrets left in `mcp.toml`, agent configs
  and backups (it names where, never the value), MCP servers that do not run an exact version,
  the age of the mcpd token and the audit log's hash chain. `turno doctor` shows which secret
  store `keychain:` references use.
- `turno identity log --verify` (also `turno accounts log --verify`) checks the audit log's hash
  chain and exits 1 when it is broken; `log --json` lists the entries.
- mcpd expands `${VAR}`, `${VAR:-default}` and `${env:VAR}` inside a stdio server's args and env
  values and a proxied server's headers, as Claude Code does. A missing variable stops that
  server with an error that names it, instead of passing the literal text.
- `turno config set mcpd.max_request_body 64MiB` changes the largest request mcpd accepts
  (default 32 MiB).
- Logs, marks, caches and state files turno writes are created 0600 in 0700 folders.
- A secret store error prints one line instead of a stack trace; `turno mcp import
  --move-secrets` uses the secret store of the environment it runs in.
- `turno status` says why mcpd is down (its last start error, who holds its port).
  `turno mcp daemon status` says "1 client session" and shows calls in flight per session.
  `turno usage` says why an account is unknown (claude missing, a timeout) instead of `? · ?`.
- `turno mcp refresh` reports the instances mcpd could not refresh and exits 1.

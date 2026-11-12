# 0004. Resolutions from the design review and the Claude Code probes

Date: 2026-11-12. Status: accepted.

An independent review of the design raised nine questions and four risky claims. Each is
resolved below. Two probes against Claude Code 2.1.322 backed the answers:

- **Restart probe.** A Streamable HTTP server was killed and restarted between two tool calls of a
  `claude -p` run. The second call hit the new process with the old `Mcp-Session-Id`, got `404`,
  and Claude Code re-initialized on its own; the call succeeded. In the same run Claude Code opened
  several MCP sessions for one server.
- **Capabilities.** Claude Code's `initialize` advertises
  `{"elicitation":{"form":{},"url":{}},"roots":{"listChanged":true}}`.

## Decisions

1. **Working directory.** Servers get a third scope, `project`: one upstream per variant and
   project root, started in that root. The root is the git top level (worktree-specific) of the
   session folder, read from the header `X-Claudio-Cwd: ${PWD:-}`, falling back to the client's
   `roots/list`. `shared` servers start in the user's home. Imported servers default to `project`
   unless known to be folder-independent.
2. **Busy profiles.** A profile is busy when one of its own sessions is alive. Ownership comes
   from the run records written by launchers (PID to profile); sessions without a record belong
   to the `system` profile. `mcp sync` and `setup` skip only busy profiles, `--force` overrides.
3. **Delegation is enforced, not trusted.** Delegated runs use
   `-p --permission-mode dontAsk --tools "" --allowedTools <account tools>
   --disallowedTools "mcp__accounts__*" --output-format json`, so a global `bypassPermissions`
   default cannot leak in and the bridge cannot recurse. Write actions are confirmed by the user
   through an MCP elicitation form sent by mcpd to the calling session, never by a flag the model sets.
4. **Secrets of remote servers.** Remote servers whose headers reference the Keychain
   (`keychain:<service>`) are proxied by mcpd, which adds the headers upstream. OAuth remote
   servers stay direct (Claude Code owns the OAuth flow). `claudio mcp import --move-secrets`
   moves literal secrets from the old config into the Keychain.
5. **Sessions without a launcher.** When `X-Claudio-Pid` is `0`, mcpd finds the client PID from
   the TCP peer port with `lsof`.
6. **Restarts and reconnects.** Rely on Claude Code's re-initialization after `404` (verified).
   `session`-scoped instances are keyed by client PID, so reconnects and parallel MCP sessions of
   one Claude session reuse the same upstream. The session id is the key only when no PID is known.
7. **Status line path.** The status line runs as `claudio statusline`, a stable command, so plugin
   updates never break the `statusLine` setting.
8. **Tool names.** `mcp import` keeps every server name, including plugin-style names such as
   `plugin_playwright_playwright`, so tool names (`mcp__<server>__<tool>`) and permission rules
   keep working.
9. **Package names.** Publishing is out of scope for now. The command is `claudio`; npm names are
   chosen at publish time.

## Risky claims, revisited

- **Patchright MCP entry.** `patchright-core@1.64.3` contains `lib/entry/mcp.js`, which requires the
  package's own `coreBundle` (patched), so the stealth driver is used. A smoke test is the first task
  of the browser phase. Patchright disables the Console API, so `browser_console_messages` is
  expected to return nothing; documented, not hidden.
- **Server-to-client requests on shared instances.** They go to the client whose request is in
  flight on that instance (most recent if several). With none in flight mcpd answers the upstream
  with an error. `list_changed` and logging notifications go to every client of the instance.
- **Cache key.** The fingerprint hashes command, args, env references (unresolved) and the variant
  name. Each client's protocol version is negotiated by mcpd, not replayed from the cache.
- **LaunchAgent environment.** `claudio mcpd start` records the caller's `PATH` into the plist.
  Keychain items created by claudio allow `/usr/bin/security` so reading them shows no dialog.

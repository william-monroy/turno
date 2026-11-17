# 0023. Per-profile gateway tokens and per-server tool filters

Date: 2026-11-16. Status: accepted.

## Context

Every agent config that `turno mcp sync` wrote carried the same bearer token, the master token
in `~/.local/state/turno/mcpd.token`, and mcpd took the profile of a session from the
`X-Turno-Profile` header. The header was only a claim: any session (or any local process that
read one config) could name another profile, open servers whose `profiles` left its own profile
out, and get the variant of another account. The same token also opened the admin endpoints
(`/status`, `/refresh`), so every agent could inspect and refresh the gateway. Rotation existed
(`turno mcp token rotate`, ADR 0017) but could not revoke one profile without the others.

Separately, a server exposed every tool to every profile. A user who wanted the read tools of a
server in one account and nothing destructive anywhere had no way to say so.

## Decision

**Derived tokens.** Each profile gets its own token, derived from the master token:

    tp1.<profile>.<base64url(HMAC-SHA256(master, "profile:" + profile))>

The profile name travels in clear; the MAC is the secret. mcpd keeps no list of tokens: it
parses the profile out of the bearer and recomputes the MAC with a constant-time compare
(`mcpd/tokens.ts`). The derivation lives in its own module, not in `daemon.ts`, because the
gateway needs it and `daemon.ts` imports the gateway.

**The token decides the profile.** For `/mcp/<server>`:

- The session's profile is the token's profile. `X-Turno-Profile` is no longer read for identity;
  when it is present and names another profile, the request is refused (403), because that is a
  config copied across profiles or a forgery.
- A server whose `profiles` do not include the token's profile answers 403 at session start,
  even if the request claims the right profile in the header. `mcp sync` does not list such a
  server in that profile's config (as before).
- A request on an open session whose profile differs from the token's is refused, so a session
  id seen elsewhere cannot be driven with another profile's token. A session mcpd rebuilds after
  a restart takes the profile of the token that resumes it.

**The master token is for turno only.** It opens `/status` and `/refresh` and nothing else; a
profile token on those endpoints gets 403. It is never written into an agent config. A session
that sends it gets 403 with "run: turno mcp sync", and mcpd logs that once a minute (without the
token).

**Where tokens go.** `mcp sync` writes each profile's own token into its config: Claude Code
entries carry it in the `Authorization` header; plain `claude` (the hub config) gets the token of
the system profile. Codex, Copilot and Cursor read the token from `TURNO_MCPD_TOKEN`, so `sync`
writes `state/mcpd-tokens/<profile>.token` (folder 700, file 600) and their launchers read that
file instead of the master token file. Cursor's single shared `mcp.json` keeps
`${env:TURNO_MCPD_TOKEN}` and `${env:TURNO_PROFILE}`; each `cursor-agent-<p>` launcher fills them
with its own profile, and the gateway checks that they agree. `turno mcp config --agent <a>
--profile <p>` writes that profile's token file and points the snippet at it.

**Rotation.** `turno mcp token rotate` replaces the master token, which invalidates every derived
token at once; its message says so and asks for `turno mcp sync`. Removing a profile does not
revoke its token (the derivation needs no list); rotating does.

**Upgrading from an older turno.** Configs synced before this change still send the master
token, so after the upgrade (once mcpd runs the new code) their MCP sessions get 403 until the
user runs `turno mcp sync`. We chose a clean refusal over a grace period that keeps accepting
the master token with a claimed profile: that grace period would keep the hole open for exactly
the users who never resync. To make the step obvious:

- the 403 body says "run: turno mcp sync", and so does the 401 for a token from before a
  rotation;
- `turno upgrade --finish` prints the same when a synced config still holds the master token or
  a token file is stale, and `turno doctor` reports it with `turno mcp sync` as the fix;
- `upgrade --finish` already rewrites generated launchers, so Codex, Copilot and Cursor launchers
  read their profile token file; `sync` warns about a generated launcher that still reads the
  master token and names `turno profile repair <p>`.

We did not make `upgrade --finish` run `sync` by itself: sync skips profiles with open sessions,
backs up foreign entries it replaces, and edits agent configs the user may be editing; it stays an
explicit step.

**Tool filters.** A server, and a profile variant of a stdio server, may set
`tools = { allow = [...], deny = [...] }` in `mcp.toml`. Patterns are globs over the whole tool
name (`*` any run of characters, `?` one character). With `allow`, only matching tools stay;
`deny` then removes matching ones. A variant's keys replace the server's, key by key (a variant
that sets only `allow` keeps the server's `deny`), the same way a variant replaces `args`. mcpd
applies the filter: filtered tools are absent from `tools/list`, and `tools/call` on one gets a
JSON-RPC error (-32602) naming the profile and the setting, without reaching the server. The
filter needs the calls to pass through mcpd, so on a remote that does not (no secret header) it
is a config error; `turno config check` and mcpd's manifest load both refuse it, and it is never
copied into the remote entry written to agent configs. A changed filter applies to open sessions
on their next list or call.

## Consequences

- A profile's config, or its token file, now opens only the servers of that profile and only
  their allowed tools. A stolen config still grants that profile's servers until a rotation.
- Every agent config changes once on the first sync after the upgrade (new token value).
- Existing users must run `turno mcp sync` after upgrading; until then gateway servers fail with
  a message that says so.
- Agents set up by hand with an old snippet (`cat mcpd.token`) stop working the same way and need
  the new snippet from `turno mcp config`.
- The tool filter is enforced at the gateway, not by the upstream server: a server that exposes
  the same action under another tool name is not covered, so deny lists should be paired with
  allow lists for anything sensitive.
- A change to `tools` keeps the running instance: the definition fingerprint leaves tool filters
  out (changed after this ADR; at first a filter change started a fresh instance).

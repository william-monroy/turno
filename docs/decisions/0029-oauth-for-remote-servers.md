# 0029. mcpd is the OAuth client of remote servers, once per variant

Date: 2026-11-16. Status: accepted.

## Context

Remote MCP servers that need a user login (Linear, Notion, GitHub and most hosted servers)
could only be written directly into each profile's agent config. Every agent and every profile
then ran its own OAuth flow, kept its own tokens, and refreshed them on its own. That is the
pain the market notes rank highest for remote servers, and the agents' own bugs are the test
list: tokens that expire in silence, a refreshed token that is not persisted, and a rotated
refresh token lost when the Keychain write fails (the old one is already spent, so the user has
to log in again). turno already shares one stdio process between sessions and profiles, with a
variant per profile when the account differs; remote logins should work the same way.

The source of truth is the MCP authorization specification, revision 2026-07-28
(<https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>, with its pages
on authorization server discovery, client registration and security considerations), and the
documents it builds on: OAuth 2.1 (draft-ietf-oauth-v2-1-13), RFC 9728 (protected resource
metadata), RFC 8414 (authorization server metadata), RFC 7591 (dynamic client registration),
RFC 7636 (PKCE), RFC 8707 (resource indicators), RFC 9207 (issuer identification), RFC 8252
(native apps, loopback redirects), RFC 7009 (revocation) and the Client ID Metadata Document
draft (draft-ietf-oauth-client-id-metadata-document-00).

## Decision

**Declaration.** A remote server in `mcp.toml` with `auth = "oauth"` is proxied by mcpd (like a
server with a secret header). An optional `[server.<name>.oauth]` table holds `client_id`,
`client_secret` (only as a `keychain:`/`env:` reference), `client_metadata_url`, `scope`,
`callback_port` and `authorization_server`. `[server.<name>.variant.<profile>]` gives a profile
a login of its own; every other profile shares the `default` login. Variants on a remote server
are allowed only with OAuth, and an `Authorization` header next to `auth = "oauth"` is refused.

**Login, in the CLI.** `turno mcp login <server> [--profile p]` runs the flow in the user's
terminal, never in the daemon:

1. An unauthenticated `initialize` to the server; the 401's `WWW-Authenticate` gives the
   resource metadata URL and the challenge scope. Then the protected resource metadata (from
   that URL, else the path-aware well-known URL, then the root one). Without it, turno stops: the
   spec says clients MUST use it (there is no fallback to the server's origin as the
   authorization server). Its `resource` must cover the configured URL.
2. The authorization server is the first one listed, or `authorization_server`. Its metadata
   comes from the well-known URLs in the spec's order (RFC 8414 first, then OpenID Connect,
   path-inserted before path-appended). turno refuses a document whose `issuer` differs from the
   identifier it was fetched for (RFC 8414 section 3.3; a lone trailing slash on a pathless
   issuer is the only tolerance), one without `S256` in `code_challenge_methods_supported`
   (the spec says MUST refuse when it is absent), and endpoints that are not HTTPS (loopback
   HTTP is accepted for local servers and tests).
3. Registration in the spec's priority order: a hand-registered `client_id`; a Client ID
   Metadata Document when the server sets `client_id_metadata_document_supported` and the user
   hosts one (`client_metadata_url`); dynamic client registration with
   `application_type = "native"`, `token_endpoint_auth_method = "none"` and the `refresh_token`
   grant; else an error that asks for a `client_id`. turno does not host a metadata document of
   its own yet (see Consequences). A dynamic registration is reused on the next login when the
   issuer is the same and its loopback port is free again; otherwise turno registers again.
4. Scope: the configured one, else the challenge's, else the resource's `scopes_supported`;
   `--scope` adds to what the last login asked for (step-up). `offline_access` is added only
   when the authorization server lists it.
5. PKCE S256, a 256-bit `state`, and the `resource` parameter in the authorization and token
   requests. The redirect is `http://127.0.0.1:<port>/callback` (RFC 8252 loopback IP literal),
   ephemeral unless `callback_port` is set. The browser opens through the same opener as
   `turno open`; `--no-browser` prints the link.
6. On the callback, the RFC 9207 check comes first, per the spec's table: a present `iss` must
   equal the recorded issuer by simple string comparison; a missing one is refused only when the
   server advertises `authorization_response_iss_parameter_supported`. Then `state`, then the
   error or the code. Nothing from a response that fails the issuer check is shown.
7. The code exchange, then one write to the secret store.

**Storage.** One secret store item per server variant, `turno/oauth/<server>@<variant>`
(Keychain on macOS, Secret Service on Linux, through `core/secrets.ts`, value on stdin, never in
argv). It holds one line of JSON: issuer, resource, requested scope, how the client was
registered, the client information (only the id for a pre-registered client; its secret stays
a reference in `mcp.toml`), the tokens with an absolute expiry, and a timestamp. Tokens never go
to a file, a log line or command output; error messages from token requests are scrubbed of the
known token values and cut to one line.

**Use, in mcpd.** The remote transport of an OAuth server gets a `fetch` that adds
`Authorization: Bearer` only for the server's own origin. One `OAuthSession` per server variant
is shared by every instance and profile:

- An access token that expires within a minute is refreshed before use; a 401 forces one
  refresh and one retry; a second 401 is a "login required" error. Refreshes are serialized,
  so concurrent calls spend the refresh token once.
- The rotated tokens are written to the secret store **before** the new access token is
  returned. If that write fails, the tokens stay in memory (the old refresh token is spent, so
  dropping them would force a new login), the next calls retry the write, and the server's log
  gets one line without secrets. If the item changed meanwhile (a `turno mcp login` or
  `logout`), the store wins and the pending tokens are dropped.
- `invalid_grant`, `invalid_client` or `unauthorized_client` on refresh: mcpd reads the store
  once more (another login may have replaced the token), else it removes the tokens from the
  item, keeps the client registration, and fails calls with `run turno mcp login <server>
  [--profile p]`. Network errors and 5xx keep the refresh token for the next try.
- Tokens are bound to the issuer and the resource: a new authorization server in the resource
  metadata, a different `url` or a changed `client_id` means a new login, never presenting the
  old credentials elsewhere (the spec's authorization server binding).
- mcpd trusts its copy of an item for 60 seconds, and reads it again at once when it has no
  usable tokens, so a fresh login is picked up on the next call and a logout within a minute.
- A missing login does not count toward the start circuit breaker (ADR 0016): the call after
  `turno mcp login` goes through at once.
- 403 with `insufficient_scope` becomes an error that names `turno mcp login --scope`.

**Status.** `turno mcp list` (and `--json`) shows each variant's state, read from the store
only; `turno mcp doctor` exits 1 for a variant that is not logged in or needs a new login, and
`turno doctor` warns about it. `turno mcp logout <server> [--profile p | --all]` revokes the
refresh token at the authorization server when it has a revocation endpoint (best effort,
RFC 7009; `--no-revoke` skips it) and deletes the item.

**SDK.** `@modelcontextprotocol/sdk` 1.32.2 ships an `OAuthClientProvider` and an `auth()`
orchestrator. turno uses the SDK's building blocks (`discoverOAuthProtectedResourceMetadata`,
`buildDiscoveryUrls`, `registerClient`, `startAuthorization`, `exchangeAuthorization`,
`refreshAuthorization`, `extractWWWAuthenticateParams`, `checkResourceAllowed` and the metadata
schemas) but not `auth()` itself, because in that version it does not check that the metadata
echoes its issuer (its own comment says so), goes on when `code_challenge_methods_supported` is
absent, falls back to the server's origin when there is no resource metadata, has no RFC 9207
check (the redirect belongs to the application), and gives no way to keep a rotated token when
`saveTokens` fails. These checks are small and live in `mcpd/oauth.ts`.

## Consequences

- One login per account serves Claude Code, Codex, Copilot CLI and Cursor in every profile
  that uses it; two accounts of the same service are two variants.
- Tokens that are still only in memory are lost if mcpd stops before the secret store accepts
  them; the log line says so, and the next refresh then needs a login. A flush at shutdown is a
  follow-up.
- Client ID Metadata Documents work only with a URL the user hosts. Shipping a turno document
  (an HTTPS URL owned by the project, with the loopback redirect URIs) would make CIMD the
  default for servers that support it, and is the recommended follow-up; the spec now prefers
  CIMD over dynamic registration, which it marks deprecated.
- The authorization server approves a loopback redirect: per the spec it should show the
  redirect host and may warn about localhost-only clients. turno cannot prevent another local
  process from racing for the port; PKCE, `state` and the issuer check make a stolen code
  useless without the verifier.
- Step-up needs the user (`turno mcp login --scope ...`); mcpd never opens a browser itself.
- Tests run an in-process authorization server and protected MCP server on 127.0.0.1 with a
  file-backed fake `security`/`secret-tool`: discovery, registration, PKCE and `resource`,
  refusals (no PKCE, issuer mismatch, `iss` and `state`), per-variant accounts, refresh on 401
  and by clock with rotation persisted, concurrent refresh, revoked refresh, a store that
  refuses the rotated token and a later login winning over it, logout with revocation, and
  status in `mcp list` and `mcp doctor`.

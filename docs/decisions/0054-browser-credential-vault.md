# 0054. A credential vault per browser identity, filled by browser_login

Date: 2026-11-18. Status: accepted. Stage 5 of the wave 7 architecture review; builds on
ADR 0043 (the browser host and its turno tools), ADR 0047 (the turno-browser API), ADR 0051
(turno tools) and ADR 0053 (turno-core and its secret store).

## Context

A browser identity keeps its sessions in its Chrome profile, and `turno browser login` lets a
person sign in by hand. Sessions expire, though, and an agent that meets a sign-in page has two
bad options: stop and ask the person, or be given the password in the conversation, where it
lands in the transcript, the client's history and possibly a model provider's logs. Sites with
two-step sign-in add a one-time code that a person must read from an authenticator app.

The values must reach the page's form fields without passing through the model.

## Decision

**A vault per identity in the OS secret store, and a turno tool that fills from it.**

- **Storage.** `turno browser vault add <identity> <site> --url <sign-in page>` stores a
  username, a password and optionally a TOTP secret (base32, or the `otpauth://totp/` URI of
  the QR code) as one secret store item, `turno-browser/vault/<identity>/<site>`, holding one
  line of JSON. It uses turno-core's store (ADR 0053): the macOS Keychain through `security`,
  the Secret Service through `secret-tool`, exactly as turno-cli stores MCP secrets. Values
  come from hidden prompts on a terminal, or from stdin (line 1 the password, line 2 with
  `--totp` the TOTP secret); never from a flag, which would put them in the shell history and
  the process list. An item is deleted before it is written again: replacing a Keychain item in
  place (`add-generic-password -U`) opens a SecurityAgent dialog that a server cannot answer.
- **Index.** `<data>/browser/identities/<identity>.vault.json` (mode 600) lists each site with
  its origins, whether it has a TOTP secret and when it changed, and the identity's submit
  policy. It holds no value, so `vault list` never reads the store; it does check that each
  item is still there and reports a missing one. `turno browser remove` deletes the items
  before the identity, and `removeIdentity` refuses while the index still lists sites.
- **Origins.** A site is bound to the origins of its `--url` values (https, or http on
  localhost, 127.0.0.1 and [::1] for local development). `browser_login` refuses unless the
  current page's main frame is on one of them and fills only frames of those origins.
- **`browser_login <site>`** (a turno tool, ADR 0051), available when the server runs with
  `--identity`. It finds the username field (autocomplete `username`, type email, or a
  user/email/login name or id), the password field (`input[type=password]`) and the one-time
  code field (autocomplete `one-time-code`, or an otp/totp/2fa/mfa/code name or id), visible
  and in an allowed frame. The model can name a field by snapshot ref, and the same type and
  origin checks apply. It fills what it finds, so a two-step sign-in takes one call per step.
  The TOTP code is computed when the tool runs (RFC 6238 with `node:crypto`, SHA1, SHA256 or
  SHA512, 6 to 8 digits; no dependency), waiting for the next period when less than 3 seconds
  are left.
- **Redaction.** Before filling, the tool registers the values with the host's `Redactor`, and
  `SessionBackend.callTool` passes every result, stock or turno, through it; the server's error
  path does too. Each value is matched as typed and URL-, form-, JSON- and HTML-encoded and
  replaced by `[vault: <site> <field>]`. One-time codes are dropped from the redactor after 10
  minutes, passwords and usernames stay for the life of the server process. Values shorter than
  4 characters are not redacted (replacing them everywhere would wreck the snapshot).
- **Script guard.** A filled page is held until its main frame navigates or it closes; while
  held, `browser_evaluate` and `browser_run_code_unsafe` are refused on it. Because
  `browser_run_code_unsafe` runs in the server process, which can read the secret store, it is
  refused for any identity whose vault lists a site.
- **Recording guard.** The tool refuses while the server saves traces, sessions or video, or
  has the devtools capability: those files would keep the filled values.
- **Submitting.** By default (`confirm`) the tool only fills, and the model clicks the sign-in
  button as its own, visible tool call. `turno browser vault submit <identity> auto` lets the
  tool press Enter in the last filled field and wait for the page to load.
- **API.** turno-browser's API (ADR 0047) gains `vaultAdd`, `vaultList`, `vaultRemove`,
  `vaultClear`, `vaultSetSubmit` and `parseTotpSecret`: version 1.1. turno-cli asks for 1.1, so
  an older turno-browser is refused with the message that says to update it.

## Alternatives considered

- **A `browser_fill_secret` that takes a secret name from `turno secret`.** Generic, but MCP
  server secrets are not bound to an origin, so a model led to another site could fill them
  there. Per-site items with origins make that binding part of the data.
- **An encrypted vault file.** It needs a key, and the only safe place for that key is the
  secret store; storing the values there directly is simpler and is what turno already does.
- **Filling through the model with redaction only.** The model would still send the value as
  a tool argument, which the client logs. The tool reads the store itself so the value never
  enters the conversation in either direction.
- **Submitting by default.** Faster, but a sign-in is an action on the person's account; a
  separate click keeps it visible in the transcript and lets a person stop it. Identities that
  sign in unattended opt in.

## Consequences

- An agent can sign an identity back in, including a TOTP step, without the person and
  without the values in any transcript, log, call log (mcpd records only redacted errors) or
  snapshot.
- Redaction is a guard against accidents and an honest model, not proof against a page or a
  model set on extracting a value: a page can transform it, a screenshot shows the username.
  SECURITY.md says so.
- `browser_run_code_unsafe` is unavailable on identities with a vault; such sessions use the
  other tools, or a separate identity without credentials.
- A person who removes an item from the Keychain by hand leaves a stale index entry, which
  `vault list` flags as missing and `vault remove` cleans up.

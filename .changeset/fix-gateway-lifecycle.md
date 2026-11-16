---
"turno-cli": minor
---

MCP gateway: calls now always finish, and server requests reach the right session.

- Pressing Esc on a slow tool, closing a session, or a new optional `call_timeout` per server
  now cancels the call on the server too, so idle servers stop again as they should. Cancelling
  an `accounts_delegate` run stops the other profile's process and records it as `cancelled`.
- Editing `mcp.toml` applies to sessions that are already open (a rotated token, new args, a
  changed scope or idle time); a removed server says so instead of running the old definition.
- On a shared server, a confirmation form or sampling request is sent only to the session whose
  call asked for it; when several sessions are mid-call, it is refused instead of guessed.
  Elicitation and sampling are offered to a server only when your client supports them.
  Project and session servers get `roots/list` answered from their folder, even at startup.
- Folders with accents, CJK characters or emoji no longer break every gateway server: the
  launchers send the folder encoded (`X-Turno-Cwd-B64`; run `turno mcp sync` and `turno profile
  repair` to pick it up), and mcpd falls back to the session process folder.
- Tool lists refresh by themselves after each server start and clients are told when they
  change; `resources/list` is no longer cached across projects. The gateway has a
  `POST /refresh/<server>` endpoint.
- Remote proxies reconnect when the remote server forgets the session, and `type = "sse"` works.
- Browser-like `session` servers stay up while their session lives; exclusive leases hold
  during long calls; request bodies up to 32 MiB; resource updates go only to subscribers;
  server logs rotate while running.
- A server that keeps failing to start answers at once with the end of its log and is retried
  with backoff. After an mcpd restart, open conversations keep working instead of getting 404.
- A declared `package` that is not installed still runs through npx, now with a warning that
  suggests `turno mcp install`.

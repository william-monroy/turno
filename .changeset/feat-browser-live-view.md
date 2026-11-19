---
"turno-browser": minor
"turno-cli": minor
---

Live view and take-over for browser identities, off by default. `turno browser set <id> --live true` (or `turno-browser-mcp --live`) serves a view of the agent's tab on 127.0.0.1 with a per-server token; `turno browser live <id>` opens it through a link that works once and is never printed. `turno browser pause <id>` (or Pause in the view) holds the agent's next call, up to `live.wait` (2 minutes by default), while you act in the window or through the view; `turno browser resume <id>` lets it go, and each held call is told what changed (URL, title, tabs, your input) and a call that would act on stale refs is not run: it returns an error with a fresh snapshot. The natural language and captcha tools are held too, and a `browser_act` run stops at its next step. A page that holds a vault value or a password is never shown, including a sign-in typed key by key with humanize. Read mode and attach mode refuse the view and keep pause and resume. turno-browser API 1.9, identity.json format 10.

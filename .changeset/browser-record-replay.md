---
"turno-browser": minor
"turno-cli": minor
---

Record and replay. `browser_record` saves an agent's actions on an identity as a named flow, each
element kept four ways (Playwright's locator, role and name, text, CSS path) and typed text as
parameters; passwords, one-time codes and values marked sensitive are never saved, and a vault
sign-in is kept as `browser_login` with the site name. `browser_replay` runs a flow with
parameters (`keychain:<item>` reads one from the secret store) and, when a step no longer fits,
stops with a report the agent can continue from; `browser_flows` lists them. Opt-in per identity
(`record` in identity.json, `turno browser record <id>`): every session as a flow, Playwright
traces and a screenshot per action under a size cap, with the trace stopped around sign-ins.
New commands `turno browser flows|replay|record|traces`; `traces --open` uses the trace viewer
bundled with patchright-core.

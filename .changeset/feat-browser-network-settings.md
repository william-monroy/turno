---
"turno-browser": minor
"turno-cli": minor
---

Opt-in network and user agent settings, and a Camoufox engine, all off by default and not
recommended for your own accounts. identity.json format 8 adds `userAgent` and `proxy`, and the
`engine` key takes `"camoufox"`; API_VERSION is 1.7 and turno-cli needs it.
`"userAgent": "coherent"` takes no typed value: a headless Chrome gets the user agent a headed one
of the same version sends, with its real client hints metadata, and a launch check refuses any
contradiction between the user agent, client hints, platform, headers, languages and time zone.
`proxy` sends the identity's traffic (sign-ins included) through an http, https or SOCKS proxy,
with its password only from the secret store, hidden from every tool result, and WebRTC limited
to the proxy. `--engine camoufox` runs an identity on an installed Camoufox through stock
playwright-core, with its own Firefox profile; turno never downloads it, and every stock tool but
`browser_run_code_unsafe` runs. New flags on `turno identity set` (`--user-agent`,
`--proxy-server`, `--proxy-username`, `--proxy-password`, `--no-proxy`), doctor checks for
Camoufox and the proxy credentials, and fingerprint bench checks that compare headers and a
worker with the page.

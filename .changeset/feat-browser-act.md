---
"turno-browser": minor
"turno-cli": minor
---

Natural language actions and captcha solving for browser identities, both not recommended and off by default.

- `turno identity set browser:<id> --act` lists `browser_act` (an instruction carried out one stock browser action at a time, every step shown), `browser_extract` (data off the page as JSON) and `browser_observe` (proposed calls, not run). The model is your client's, through MCP sampling, or a chat completions API you name with `--act-provider chat-completions --act-endpoint <url> --act-model <name> --act-key keychain:<item>`. The model sees the instruction and a snapshot of the current tab with vault values and password, one-time code and card fields hidden; it can only click, type, select, press keys, hover, drag, wait and go back on that tab; steps, tokens and time are capped per call (`--act-max-steps`, `--act-max-tokens`, `--act-timeout`). A recorded flow keeps the stock steps it chose, never the instruction or the page.
- `--captcha-provider task-api --captcha-endpoint <url> --captcha-key keychain:<item>` lists `browser_solve_captcha`, which sends a reCAPTCHA v2, hCaptcha or Turnstile widget and the page address to that solver service and puts the token into the page. The service sees the page, and solving a site's captchas by machine may break its terms: it is meant for your own accounts. Every attempt is a line in the identity's reputation log, and `turno browser reputation` shows a `solved` column once a solver answered. Read mode refuses it.
- Keys are only `keychain:` references read from the secret store at use time, refused as literal values without being echoed, and hidden from every result.
- identity.json format 8 (`act`, `captcha`); turno-browser API 1.7, which turno-cli now requires.

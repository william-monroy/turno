# turno-browser

An MCP server that lets a coding agent drive your installed Google Chrome with a persistent
profile per identity: you sign into a site once by hand, and the agent works in that same
signed-in browser afterwards. It is the Playwright MCP program, run on Patchright (a Playwright
fork that drives Chrome without the automation flags Playwright adds).

It is a separate package from [turno](https://www.npmjs.com/package/turno-cli), not installed
with it; turno works without it.

```sh
npm install --global turno-browser
turno identity add browser:school     # prints the mcp.toml entry for this identity
turno identity login browser:school   # sign in by hand once; cookies persist
```

Or run it directly as an MCP server: `turno-browser-mcp --identity school`. It serves over
stdio; `--port` or `--host` with `--identity` would serve a signed-in browser over HTTP, so it
needs `--allow-http-identity` and then listens on 127.0.0.1 only.

Defaults: headed, the installed Chrome channel, a persistent user data dir per identity, no
injected init scripts. The reasons, and what these settings do and do not change, are in
[ADR 0005](https://github.com/wimo-dev/turno/blob/main/docs/decisions/0005-stealth-browser-defaults.md).

## Acceptable use

Use it with your own accounts, on sites whose terms allow automated access by you, and at a
human pace. Do not use it to get around access controls, paywalls, CAPTCHAs or rate limits, to
scrape at scale, or to access accounts that are not yours. You are responsible for how you use
it. The software is provided "as is", without warranty (Apache License 2.0).

## License

Apache-2.0. Patchright and Playwright are Apache-2.0 and install as regular npm dependencies.

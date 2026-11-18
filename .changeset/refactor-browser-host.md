---
"turno-browser": minor
---

`turno-browser-mcp` is now the MCP server host instead of a wrapper that ran the Playwright MCP
program bundled in `patchright-core` (ADR 0043). It launches Chrome itself through one engine
module, serves stdio with the MCP SDK, and runs every stock tool through upstream's tool
backend, so the 25 tool names and input schemas, every flag, `TURNO_BROWSER_IDLE`, the idle
close, the orphan sweep and the bounded shutdown work as before. `--port` keeps upstream's HTTP
server. `initialize` now reports `turno-browser` and its version. A registry for turno's own
tools is in place (no new tools yet). `@modelcontextprotocol/sdk` is now a dependency.

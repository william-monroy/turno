# 0003. Reuse the Playwright MCP program shipped inside patchright-core

Date: 2026-11-12. Status: accepted.

## Context

Stock Playwright is detected by many sites (CDP `Runtime.enable` leak, `navigator.webdriver`,
automation flags). Patchright is a patched Playwright fork. Writing our own browser MCP server
would mean reimplementing about 30 tools that `@playwright/mcp` already has.

Inspection of the npm tarballs on 2026-11-12: `@playwright/mcp@0.0.85` is a thin `cli.js` that
calls `tools.decorateMCPCommand` from `playwright-core/lib/coreBundle`. `patchright-core@1.64.3`
ships the same program as `lib/entry/mcp.js`, built from the patched sources.

## Decision

`@claudio/browser` runs `patchright-core/lib/entry/mcp.js` (resolved from the installed package
path, since the subpath is not in `exports`) with stealth defaults: Chrome channel, headed, and a
persistent user data dir per identity.

## Consequences

- Same tool names and flags as Playwright MCP, so skills written for it keep working.
- We depend on an internal path of patchright-core; a smoke test catches breakage on upgrade.
- Comparison with other engines (Camoufox, nodriver) happens in `claudio browser bench`, not by
  assumption.

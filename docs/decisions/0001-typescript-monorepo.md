# 0001. TypeScript monorepo with two npm packages and a plugin

Date: 2026-11-12. Status: accepted.

## Context

The original `claudio` is a 690-line bash script with embedded Python. The new scope adds an
MCP gateway, a Patchright-based browser and an accounts bridge. The MCP SDK and Patchright
are Node libraries. The project should be easy to install and contribute to.

## Decision

- One pnpm workspace. Package `claudio` holds the CLI, the core library, mcpd and the
  accounts bridge, so one install gives the whole command. Package `@claudio/browser` is
  separate because Patchright is a large optional dependency.
- TypeScript in strict ESM, compiled with `tsc`. Tests with Vitest.
- CLI parsing with `node:util` `parseArgs`; config in TOML via `smol-toml`.
- Generated launchers stay POSIX `sh` so starting a session never pays a Node startup.

## Consequences

- Node >= 20 is required. macOS ships no Node, but every Claude Code user already has one.
- The hot paths (`claudio auto`, `claudio resolve`) must avoid importing the MCP SDK; command
  modules are loaded lazily.

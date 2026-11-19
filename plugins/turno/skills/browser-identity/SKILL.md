---
name: browser-identity
description: Drives a turno browser identity (a Chrome profile the user signed into, served by turno-browser-mcp) from the shell with `turno browser do`. Use it when the user asks to open, read, check or act on a web page with a browser identity ("as school", "with browser:work", "in my signed-in browser"), or wants browser work done and the turno command is there but no browser MCP tools are.
---

# Use a browser identity from the shell

`turno browser do <id> <action>` runs one action on the identity's browser through turno's gateway,
the same server and rules an agent's MCP tools use.

## First

1. Run `turno browser do --help` and follow it: it is the reference for the turno installed here
   (actions, flags, output). This skill only gives the loop.
2. The identity: the one the user named, else `turno browser identities`. Ask if more than one fits.

## The loop

1. `turno browser do <id> open <url>`
2. `turno browser do <id> snapshot`: the page tree with refs (`e12`).
3. Act by ref: `click <ref>`, `type <ref> <text> [--submit]`, `select <ref> <value>`, `press <key>`.
   Refs come from the last snapshot; take a new one after the page changes.
4. `read` for the page's text, `find <text>` to locate an element, `screenshot --out <file>` to look.
5. When done, `turno browser do <id> end` (keeps the browser running and frees the tab or lease).

Your commands share one session and one tab by themselves. Subagents working at the same time
each pass their own `--session <name>`.

## Rules

- Never type a password or code: `login <site>` fills it from the vault, unseen. If there is no
  vault entry, ask the user.
- An error is one `error:` line on stderr with exit 1: read it and act on it. "in use by another
  session": another agent holds the identity; wait or ask. "not served by mcpd" or exit 5: tell the
  user the command the message names; do not edit `mcp.toml` or start services yourself.
- A signed-out site: tell the user to run `turno identity login browser:<id>`.
- Browser trouble you cannot explain: run `turno browser doctor` and follow its output.
- Do not run `call browser_run_code_unsafe`.

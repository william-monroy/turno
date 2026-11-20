---
"turno-browser": minor
"turno-cli": patch
---

`turno-browser init` sets turno-browser up step by step: it names and creates an identity (or
uses one that is there), opens Chrome to sign in by hand on a first site, finds the agents
installed here and runs the agent's `mcp add` command only on a yes. Without a terminal it needs
`--identity` and `--agent`, skips the sign-in and prints the command instead. `turno-browser`
with no command now points to it.

The first steps say more of what happened:

- `login` opens a page that says what to do instead of a blank tab, and on close names the sites
  that were opened, or says that nothing new was signed in.
- `show` has a "last sign-in" line, local times and a hint to turn on the health check;
  `doctor` says when an identity was never signed in by hand.
- `list`, `show` and `doctor` say "not in use" instead of "free".
- `do <id> end` says that Chrome stays open in the background server and how to close it now.
- `do` errors no longer start with "Error: Error:", and a stale ref or text where a ref goes gets
  a hint (`snapshot`, `find`).
- `setup claude` suggests `claude-code`.
- `add` prints its next steps with each explanation on its own line, so the commands paste into
  zsh as they are.

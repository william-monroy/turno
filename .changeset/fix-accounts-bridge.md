---
"turno-cli": minor
---

The accounts bridge no longer trusts the calling model to say what a delegated run may do:

- Accounts take `read_tools` (`turno identity add ... --read-tools <patterns>`). A delegated read gets only those tools, so it cannot send, post or delete even if injected text tells it to; Claude Code refuses anything else, and the refused tools are reported.
- Accounts take `confirm = "always" | "writes" | "never"` (`--confirm`). The default is `always` for mail and messaging services (every call asks the user) and `writes` elsewhere. A read of an account without `read_tools` is now confirmed like a write: add `read_tools` to keep unconfirmed reads.
- The headless run starts in turno's own empty folder instead of the caller's, loads no settings files (`--setting-sources ""`), gets a minimal environment, and loads only the account's MCP servers (`--strict-mcp-config`) when they go through the turno gateway.
- The result comes back marked as data from another account and capped at 20,000 characters.
- Every audit log line records the decision: policy, whether the user was asked and the answer, the allowed tools, the MCP mode and refused tools. `turno identity list` shows each account's policy and `turno identity log` shows the decisions.

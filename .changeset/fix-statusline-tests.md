---
"turno-cli": patch
---

The status line no longer shows `$0.00` for models it has no price for: it shows Claude Code's own
figure or `$?`. Prices were added for Claude Opus 4.5 and 4.1, Sonnet 4.5 and 4, the 3.x models,
Mythos, and Bedrock or Vertex model ids; Fable 5.2, Sonnet 5.5 and Haiku 5.5 prices were corrected.
A damaged cache file, an unexpected payload, a full disk or a read-only state folder now leaves one
part of the line empty instead of replacing the whole line with an error. The plan is asked again
every 10 minutes until it is known. The branch is read without running git, the status line cache
is pruned after a week, and the line shows `mcpd down` when the MCP gateway the agents use does not
answer.

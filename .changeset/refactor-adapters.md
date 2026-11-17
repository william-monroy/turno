---
"turno-cli": patch
---

Internal: each agent's differences now live in its adapter (ADR 0032), dead code is gone, and `pnpm check` lints with Biome and knip. No output changes for valid setups; an agent JSON config that is valid JSON but not an object is now reported instead of rewritten by `turno mcp sync`.

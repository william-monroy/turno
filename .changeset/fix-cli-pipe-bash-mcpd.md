---
"turno-cli": patch
"turno-browser": patch
"turno-core": patch
---

- `turno --help | head` and `turno-browser --help | head` end quietly instead of printing an
  EPIPE stack trace when the reader stops early.
- Bash completion works on the bash 3.2 macOS ships: each word reaches turno on its own, and
  the script loads with `eval "$(turno completion bash)"`, since bash 3.2 cannot source `<(...)`.
- `turno mcp daemon run` stops by itself when its home folder is removed (a throwaway HOME
  someone deleted), instead of running on with nothing left to serve.

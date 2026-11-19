---
"turno-cli": patch
---

`turno doctor`, `turno status`, `turno mcp daemon status` and `turno doctor --security` no longer
wait for lsof to tell who holds mcpd's port. A free port is told by a refused connection, and a
running mcpd's port is checked against the pid it reports, so lsof's scan of every process (which
takes seconds on a busy Mac) runs only when another process holds the port. When lsof cannot say
which process that is, doctor still reports the port as in use.

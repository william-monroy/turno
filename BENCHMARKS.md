# Benchmarks

## MCP server memory

turno is about switching accounts and keeping everything else; its MCP gateway is one part of
that, and this page measures what the gateway does to memory. The measurement behind the
gateway: 18 Claude Code sessions open on a 16 GB Mac held about 11.7 GB in MCP server processes,
most of them copies of the same few servers. This benchmark reproduces that effect with public
servers so anyone can check the claim.

### Method

`bench/mcp-ram.mjs` installs six popular local MCP servers into a temporary folder (no API keys
needed, versions pinned in the script):

- `@playwright/mcp`
- `chrome-devtools-mcp`
- `@modelcontextprotocol/server-filesystem`
- `@modelcontextprotocol/server-memory`
- `@modelcontextprotocol/server-sequential-thinking`
- `@upstash/context7-mcp`

It then measures three setups with N simulated sessions. Each session does what an agent does
when it starts: `initialize` and `tools/list` on every server.

| Setup | What runs |
|---|---|
| **Direct** | every session starts every server over stdio, as with a plain `mcpServers` entry (`--npx` starts them through `npx -y`, as most server READMEs suggest) |
| **turno, all servers running** | one `mcpd` (shared scope) with an empty tool cache: each server starts once to learn its tools and stays up for every session |
| **turno, idle** | `mcpd` restarted with the cache the first round wrote: the tool lists come from the cache and no server starts until a tool is called |

Memory is the sum of the resident set size (RSS) of every process involved, read from `ps`
three seconds after the last session connected. The script uses a throwaway `HOME` and never
reads or changes your own configuration.

```sh
pnpm install && pnpm build
node bench/mcp-ram.mjs --sessions 8 --out bench/results/mine.json
node bench/mcp-ram.mjs --sessions 4 --npx
```

### Results

Apple M3, 16 GB, macOS, Node 26.13, 2026-11-16 (raw output in [bench/results](bench/results)):

| Sessions | Direct | turno, all servers running | turno, idle |
|---|---|---|---|
| 4 | 1,410 MiB, 28 processes | 692 MiB, 8 processes | 101 MiB, 1 process |
| 8 | 3,163 MiB, 56 processes | 847 MiB, 8 processes | 103 MiB, 1 process |
| 4, servers through `npx -y` | 3,123 MiB, 52 processes | | |

With 8 sessions the gateway uses 73% less memory while every server runs and 97% less while
they are idle. Direct memory grows with every session; the gateway's stays nearly flat, because
only `mcpd` grows (one HTTP session per client).

### Caveats

- RSS counts shared pages once per process, so sums overstate real pressure somewhat for both
  setups. Activity Monitor's "Memory" column (physical footprint) gives lower absolute numbers
  but the same ratio.
- Servers that keep state per session (a browser driven by one agent at a time) should run with
  `scope = "session"` or `exclusive = true`, which gives back some of the saving. Stateless
  servers (docs, search, memory, issue trackers) share safely.
- Servers that open a browser or index files use much more memory once a tool runs; this
  benchmark only starts them and lists their tools, which is what every session pays even if it
  never calls them.
- Run it on your own machine with your own servers before quoting a number: `turno mcp list`
  shows what you run, and the script's `SERVERS` list is easy to edit.

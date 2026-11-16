#!/usr/bin/env node
// Measures the memory of MCP servers with and without the turno gateway.
//
//   node bench/mcp-ram.mjs [--sessions 4] [--npx] [--out bench/results.json]
//   node bench/mcp-ram.mjs --show bench/results/<file>.json   print a saved result as a table
//
// Direct: every "session" starts every server itself over stdio, the way an agent does with a
// plain mcpServers entry, then runs initialize and tools/list. --npx starts them through
// `npx -y <package>`, as most server READMEs suggest. Gateway: the same sessions connect to one
// turno mcpd (shared scope) in a throwaway HOME, first with an empty tool cache (each server
// starts once to learn its tools) and then with a warm cache (nothing starts until a tool runs).
// Memory is the sum of resident set sizes of every process involved, read from `ps`.
//
// It installs the servers into a temporary folder and never touches your own config.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "packages/turno/dist/cli/main.js");
const require = createRequire(join(ROOT, "packages/turno/package.json"));
const sdk = (p) => import(pathToFileURL(require.resolve(`@modelcontextprotocol/sdk/${p}`)).href);

/** Popular local servers that start without an API key. Versions are pinned for repeatable runs. */
const SERVERS = [
  { name: "playwright", pkg: "@playwright/mcp", version: "0.0.85", bin: "playwright-mcp" },
  { name: "devtools", pkg: "chrome-devtools-mcp", version: "1.13.0", bin: "chrome-devtools-mcp" },
  { name: "filesystem", pkg: "@modelcontextprotocol/server-filesystem", version: "2.3.0", bin: "mcp-server-filesystem", args: ["/tmp"] },
  { name: "memory", pkg: "@modelcontextprotocol/server-memory", version: "2.1.1", bin: "mcp-server-memory" },
  { name: "thinking", pkg: "@modelcontextprotocol/server-sequential-thinking", version: "2.1.1", bin: "mcp-server-sequential-thinking" },
  { name: "context7", pkg: "@upstash/context7-mcp", version: "4.7.0", bin: "context7-mcp" },
];

const { values } = parseArgs({
  options: {
    sessions: { type: "string", default: "4" },
    npx: { type: "boolean", default: false },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
    show: { type: "string" },
  },
});
const SESSIONS = Number(values.sessions);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** RSS in KiB of a process and all its descendants. */
function treeRss(rootPids) {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map();
  for (const [pid, ppid] of rows) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  const rss = new Map(rows.map(([pid, , r]) => [pid, r]));
  const seen = new Set();
  const stack = [...rootPids];
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p) || !rss.has(p)) continue;
    seen.add(p);
    stack.push(...(kids.get(p) ?? []));
  }
  let total = 0;
  for (const p of seen) total += rss.get(p);
  return { kib: total, processes: seen.size };
}

const mib = (kib) => Math.round(kib / 1024);

function install(dir) {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "bench", private: true }));
  const specs = SERVERS.map((s) => `${s.pkg}@${s.version}`);
  process.stderr.write(`installing ${specs.length} servers into ${dir}\n`);
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--silent", ...specs], { cwd: dir, stdio: "inherit" });
}

const binPath = (dir, s) => join(dir, "node_modules/.bin", s.bin);

async function listOver(transport) {
  const { Client } = await sdk("client/index.js");
  const client = new Client({ name: "bench", version: "1" });
  await client.connect(transport);
  const tools = await client.listTools();
  return { client, tools: tools.tools.length };
}

async function direct(dir) {
  const { StdioClientTransport } = await sdk("client/stdio.js");
  const clients = [];
  const pids = [];
  for (let i = 0; i < SESSIONS; i++) {
    for (const s of SERVERS) {
      const t = values.npx
        ? new StdioClientTransport({ command: "npx", args: ["-y", `${s.pkg}@${s.version}`, ...(s.args ?? [])], cwd: dir, stderr: "ignore" })
        : new StdioClientTransport({ command: binPath(dir, s), args: s.args ?? [], stderr: "ignore" });
      const { client } = await listOver(t);
      clients.push(client);
      pids.push(t.pid);
    }
  }
  await sleep(3000);
  const m = treeRss(pids);
  for (const c of clients) await c.close().catch(() => {});
  return m;
}

async function gateway(dir, home) {
  const port = 47000 + Math.floor(Math.random() * 900);
  const toml = SERVERS.map((s) => `[server.${s.name}]\ncommand = ${JSON.stringify(binPath(dir, s))}\nargs = ${JSON.stringify(s.args ?? [])}\nscope = "shared"\n`).join("\n");
  mkdirSync(join(home, ".config/turno"), { recursive: true });
  writeFileSync(join(home, ".config/turno/mcp.toml"), toml);
  writeFileSync(join(home, ".config/turno/config.toml"), `[mcpd]\nport = ${port}\n`);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local/state"), XDG_DATA_HOME: join(home, ".local/share") };
  const daemon = spawn(process.execPath, [CLI, "mcp", "daemon", "run"], { env, stdio: "ignore" });
  const tokenFile = join(home, ".local/state/turno/mcpd.token");
  for (let i = 0; i < 100 && !existsSync(tokenFile); i++) await sleep(100);
  await sleep(500);
  const token = readFileSync(tokenFile, "utf8").trim();
  const { StreamableHTTPClientTransport } = await sdk("client/streamableHttp.js");

  const round = async () => {
    const clients = [];
    for (let i = 0; i < SESSIONS; i++) {
      for (const s of SERVERS) {
        const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${s.name}`), {
          requestInit: { headers: { Authorization: `Bearer ${token}`, "X-Turno-Profile": `p${i}`, "X-Turno-Pid": String(process.pid) } },
        });
        clients.push((await listOver(t)).client);
      }
    }
    await sleep(3000);
    const m = treeRss([daemon.pid]);
    for (const c of clients) await c.close().catch(() => {});
    return m;
  };

  const cold = await round();
  daemon.kill("SIGTERM");
  await sleep(1500);
  // Restart with the tool cache the first round wrote: nothing starts until a tool is called.
  const daemon2 = spawn(process.execPath, [CLI, "mcp", "daemon", "run"], { env, stdio: "ignore" });
  await sleep(1500);
  const warmRound = async () => {
    const clients = [];
    for (let i = 0; i < SESSIONS; i++) {
      for (const s of SERVERS) {
        const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${s.name}`), {
          requestInit: { headers: { Authorization: `Bearer ${token}`, "X-Turno-Profile": `p${i}`, "X-Turno-Pid": String(process.pid) } },
        });
        clients.push((await listOver(t)).client);
      }
    }
    await sleep(3000);
    const m = treeRss([daemon2.pid]);
    for (const c of clients) await c.close().catch(() => {});
    return m;
  };
  const warm = await warmRound();
  daemon2.kill("SIGTERM");
  await sleep(1000);
  return { cold, warm };
}

function show(file) {
  const r = JSON.parse(readFileSync(file, "utf8"));
  const n = (x) => x.toLocaleString("en-US").padStart(6);
  const row = (label, m) => `  ${label.padEnd(30)}${n(m.mib)} MiB  ${String(m.processes).padStart(2)} ${m.processes === 1 ? "process" : "processes"}`;
  console.log(`${r.sessions} sessions x ${r.servers.length} MCP servers (${r.machine})`);
  console.log(row(`each session starts its own`, r.direct));
  console.log(row("turno, all servers running", r.gatewayColdCache));
  console.log(row("turno, idle", r.gatewayWarmCache));
}

async function main() {
  if (values.show) return show(values.show);
  if (!existsSync(CLI)) throw new Error("build first: pnpm build");
  const work = mkdtempSync(join(tmpdir(), "turno-bench-"));
  try {
    install(work);
    const d = await direct(work);
    const g = await gateway(work, join(work, "home"));
    const result = {
      date: new Date().toISOString(),
      machine: `${execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).trim()}, ${Math.round(Number(execFileSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" })) / 2 ** 30)} GB`,
      node: process.version,
      sessions: SESSIONS,
      servers: SERVERS.map((s) => `${s.pkg}@${s.version}`),
      direct: { mode: values.npx ? "npx -y" : "installed binaries", mib: mib(d.kib), processes: d.processes },
      gatewayColdCache: { mib: mib(g.cold.kib), processes: g.cold.processes },
      gatewayWarmCache: { mib: mib(g.warm.kib), processes: g.warm.processes },
    };
    const text = JSON.stringify(result, null, 2);
    console.log(text);
    if (values.out) writeFileSync(values.out, `${text}\n`);
  } finally {
    if (!values.keep) rmSync(work, { recursive: true, force: true });
  }
}

await main();

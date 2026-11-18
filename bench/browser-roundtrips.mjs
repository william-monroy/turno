#!/usr/bin/env node
// Round trips of turno-browser for a fixed form-filling sequence on a local page.
//
//   pnpm build && node bench/browser-roundtrips.mjs [--runs 3] [--headed] [--json]
//     [--modes calls,batch] [--bin <path to another build's dist/bin/mcp.js>] [--methods]
//
// --bin measures another build (an older commit, for a before and after) with the same client;
// a build without browser_batch or `settle` can run only the "calls" mode. --methods also prints
// the CDP commands of the last run of each mode, by method.
//
// Starts the built `turno-browser-mcp` on a throwaway identity in a throwaway HOME (headless
// unless --headed), with DEBUG=pw:protocol so every Chrome DevTools Protocol command it sends is
// one "SEND" line on stderr, and runs the same sequence in each mode:
//
//   navigate, type x2, select, click (check box), click (submit, which fetches and renders),
//   wait for the result text, snapshot
//
// on a form with 300 more links and buttons below it, so a snapshot has a realistic size.
//
//   calls       one MCP call per action, upstream's default settle (500 ms)
//   calls-100   the same with the identity's "settle": "100ms"
//   batch       one browser_batch call with the same actions and snapshot: true
//   batch-100   the batch with "settle": "100ms"
//
// For each mode it reports the median over the runs of: wall time of the sequence, CDP commands
// sent during it, MCP calls the model makes, and bytes of tool results the model reads. Chrome's
// launch happens before the sequence (a browser_tabs call) and is not counted. Nothing outside
// the throwaway HOME is touched.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    headed: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    modes: { type: "string", default: "calls,calls-100,batch,batch-100" },
    bin: { type: "string" },
    methods: { type: "boolean", default: false },
  },
});
const BIN = values.bin ?? join(ROOT, "packages/browser/dist/bin/mcp.js");
const require = createRequire(join(ROOT, "packages/browser/package.json"));
const { writeIdentitySettings } = await import(pathToFileURL(join(ROOT, "packages/browser/dist/settings.js")).href);
const sdk = (p) => import(pathToFileURL(require.resolve(`@modelcontextprotocol/sdk/${p}`)).href);

const RUNS = Number(values.runs);

const FORM = `<!doctype html><title>Sign up</title>
<h1>Sign up</h1>
<form id="f" onsubmit="event.preventDefault(); save()">
  <label>Name <input id="name"></label>
  <label>Email <input id="email" type="email"></label>
  <label>Plan <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select></label>
  <label><input id="agree" type="checkbox"> I agree</label>
  <button id="submit">Save</button>
</form>
<p id="out"></p>
<ul>${Array.from({ length: 150 }, (_, i) => `<li><a href="#item-${i}">Item ${i}</a> <button>Action ${i}</button></li>`).join("")}</ul>
<script>
async function save() {
  const r = await fetch('/api/save', { method: 'POST', body: JSON.stringify({ name: document.getElementById('name').value }) });
  document.getElementById('out').textContent = (await r.json()).message;
}
</script>`;

async function site() {
  const server = createServer((req, res) => {
    if (req.url === "/api/save") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () =>
        setTimeout(() => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ message: `Saved ${JSON.parse(body).name}` }));
        }, 50),
      );
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(FORM);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

function actions(url) {
  return [
    { tool: "browser_navigate", arguments: { url: `${url}/form` } },
    { tool: "browser_type", arguments: { target: "#name", text: "Alice" } },
    { tool: "browser_type", arguments: { target: "#email", text: "alice@example.com" } },
    { tool: "browser_select_option", arguments: { target: "#plan", values: ["pro"] } },
    { tool: "browser_click", arguments: { target: "#agree" } },
    { tool: "browser_click", arguments: { target: "#submit" } },
    { tool: "browser_wait_for", arguments: { text: "Saved Alice" } },
  ];
}

const textOf = (res) => (res.content ?? []).map((c) => c.text ?? "").join("\n");

async function runOnce(mode, url) {
  const { Client } = await sdk("client/index.js");
  const { StdioClientTransport } = await sdk("client/stdio.js");
  const home = mkdtempSync(join(tmpdir(), "turno-bench-rt-"));
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir(), DEBUG: "pw:protocol" };
  const settle = mode.endsWith("-100") ? "100ms" : undefined;
  if (settle) writeIdentitySettings("bench", { settle }, env);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, "--identity", "bench", ...(values.headed ? [] : ["--headless"])],
    env,
    cwd: home,
    stderr: "pipe",
  });
  let sends = 0;
  let counting = false;
  const methods = new Map();
  transport.stderr.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (!line.includes("pw:protocol SEND")) continue;
      sends++;
      const method = /"method":"([^"]+)"/.exec(line)?.[1] ?? "?";
      if (counting) methods.set(method, (methods.get(method) ?? 0) + 1);
    }
  });
  const client = new Client({ name: "bench", version: "0.0.0" });
  await client.connect(transport);
  try {
    const call = async (name, args) => {
      const res = await client.callTool({ name, arguments: args });
      if (res.isError) throw new Error(`${name}: ${textOf(res)}`);
      return textOf(res);
    };
    await call("browser_tabs", { action: "list" });
    await new Promise((r) => setTimeout(r, 300));
    const before = sends;
    counting = true;
    const t0 = performance.now();
    let calls = 0;
    let bytes = 0;
    if (mode.startsWith("batch")) {
      bytes += (await call("browser_batch", { actions: actions(url), snapshot: true })).length;
      calls = 1;
    } else {
      for (const a of actions(url)) {
        bytes += (await call(a.tool, a.arguments)).length;
        calls++;
      }
      bytes += (await call("browser_snapshot", {})).length;
      calls++;
    }
    const ms = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 300));
    counting = false;
    return { ms, cdp: sends - before, calls, bytes, methods };
  } finally {
    await client.close().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const web = await site();
const results = {};
try {
  for (const mode of values.modes.split(",")) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await runOnce(mode, web.url));
    results[mode] = {
      ms: Math.round(median(runs.map((r) => r.ms))),
      cdp: median(runs.map((r) => r.cdp)),
      calls: runs[0].calls,
      bytes: median(runs.map((r) => r.bytes)),
    };
    if (!values.json) process.stderr.write(`${mode}: ${JSON.stringify(results[mode])}\n`);
    if (values.methods) {
      const top = [...runs.at(-1).methods].sort((a, b) => b[1] - a[1]);
      process.stderr.write(`${top.map(([m, n]) => `  ${n} ${m}`).join("\n")}\n`);
    }
  }
} finally {
  await web.close();
}

if (values.json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
else {
  const rows = Object.entries(results).map(([mode, r]) => `| ${mode} | ${r.ms} | ${r.cdp} | ${r.calls} | ${r.bytes} |`);
  process.stdout.write(
    `${["| mode | wall ms | CDP commands | MCP calls | result bytes |", "|---|---|---|---|---|", ...rows].join("\n")}\n`,
  );
}

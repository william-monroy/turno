#!/usr/bin/env node
// Evaluation suite for turno-browser: a fixed set of browser tasks on local fixture pages, run
// through the real MCP server, with paired A/B runs so a change can be judged.
//
//   pnpm build && pnpm bench:browser                       # every task, the default config
//   pnpm bench:browser --b settle-100 --rounds 5           # A/B: default against settle-100
//   pnpm bench:browser --smoke                             # the quick subset CI runs
//   pnpm bench:browser --list                              # tasks and configurations
//
// Options:
//   --a <config>          configuration A (default: default)
//   --b <config>          configuration B; with it every task runs in both, in pairs, and the
//                         one that goes first alternates by round
//   --rounds <n>          runs of each task per configuration (default 3)
//   --tasks <a,b>         only these tasks
//   --smoke               only the smoke tasks, one round (unless --rounds is given)
//   --config-file <file>  more configurations, a JSON list (see bench/browser/lib/configs.mjs)
//   --headed              visible Chrome windows (default headless; a configuration can override)
//   --json                print the JSON report instead of tables
//   --out <file>          also write the JSON report to a file
//   --seed <n>            seed of the bootstrap intervals (default 1)
//
// Every run starts the built turno-browser-mcp on a throwaway identity in a throwaway HOME and
// a fresh fixture site, launches Chrome before measuring (a browser_evaluate that reads the
// user agent), then runs the task and records: success (from what the site received), tool
// calls, tool errors, wall time of the task, result bytes and estimated tokens (bytes / 4), and
// the peak resident memory of the server and its Chrome processes. Exit code 1 when any run
// failed or errored; configurations the server does not support are skipped and reported.

import { writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { parseArgs } from "node:util";
import { isHeaded, knownConfigs, readConfigsFile, resolveConfig } from "./lib/configs.mjs";
import { startSite } from "./lib/fixtures.mjs";
import { DEFAULT_BIN, UnsupportedConfig, buildVersions, memorySampler, startServer, warmUp } from "./lib/server.mjs";
import { median, paired, schedule } from "./lib/stats.mjs";
import { TASKS, pickTasks } from "./lib/tasks.mjs";

const { values } = parseArgs({
  options: {
    a: { type: "string", default: "default" },
    b: { type: "string" },
    rounds: { type: "string" },
    tasks: { type: "string" },
    smoke: { type: "boolean", default: false },
    "config-file": { type: "string" },
    headed: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    out: { type: "string" },
    seed: { type: "string", default: "1" },
    list: { type: "boolean", default: false },
  },
});

const log = (msg) => process.stderr.write(`${msg}\n`);

function fail(msg) {
  log(`eval: ${msg}`);
  process.exit(2);
}

let known;
let tasks;
let configs;
try {
  known = knownConfigs(values["config-file"] ? readConfigsFile(values["config-file"]) : []);
  tasks = pickTasks(values.tasks?.split(",").filter(Boolean), { smoke: values.smoke });
  configs = [resolveConfig(values.a, known), ...(values.b ? [resolveConfig(values.b, known)] : [])];
} catch (err) {
  fail(err.message);
}

if (values.list) {
  console.log("Tasks (* runs in --smoke):");
  for (const t of TASKS) console.log(`  ${t.smoke ? "*" : " "} ${t.id.padEnd(8)} ${t.title}`);
  console.log("\nConfigurations:");
  for (const c of known.values())
    console.log(`    ${c.name.padEnd(15)} ${c.description}${c.needs ? ` (needs ${c.needs})` : ""}`);
  process.exit(0);
}

const rounds = Number(values.rounds ?? (values.smoke ? 1 : 3));
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) fail("--rounds must be a whole number from 1 to 100");
if (configs.length === 2 && configs[0].name === configs[1].name) {
  // An A/A run: the differences show this machine's noise. B gets its own label in the report.
  configs[1] = { ...configs[1], name: `${configs[1].name}-b` };
  log("eval: A and B are the same configuration; the differences show the noise of this machine");
}

async function runOne({ task, config, round }) {
  const base = { task: task.id, config: config.name, round };
  const site = await startSite();
  let server;
  try {
    try {
      server = await startServer(config, { headed: isHeaded(config, values.headed) });
    } catch (err) {
      if (err instanceof UnsupportedConfig) return { ...base, status: "unsupported", detail: err.message };
      return { ...base, status: "error", detail: err.message };
    }
    let browser;
    try {
      browser = (await warmUp(server.client, `${site.url}/blank`)).browser;
    } catch (err) {
      return { ...base, status: "error", detail: err.message };
    }
    const sampler = memorySampler(server.pid, server.home);
    const agent = server.agent();
    const ctx = { agent, site };
    const t0 = performance.now();
    let failure;
    try {
      await task.run(ctx);
    } catch (err) {
      failure = String(err?.message ?? err);
    }
    const wallMs = Math.round(performance.now() - t0);
    const check = failure
      ? { ok: false, detail: failure }
      : await task.check(ctx).catch((err) => ({ ok: false, detail: String(err?.message ?? err) }));
    const peakMiB = await sampler.stop();
    return {
      ...base,
      status: check.ok ? "ok" : "failed",
      ...(check.detail ? { detail: check.detail } : {}),
      wallMs,
      ...agent.summary(),
      peakMiB,
      browser,
      steps: agent.steps,
    };
  } finally {
    await server?.stop();
    await site.close();
  }
}

const startedAt = new Date();
const plan = schedule(tasks, configs, rounds);
const unsupported = new Map();
const results = [];
log(
  `eval: ${tasks.length} task(s) x ${configs.length} configuration(s) x ${rounds} round(s), ${values.headed ? "headed" : "headless"}`,
);
for (const [i, item] of plan.entries()) {
  if (unsupported.has(item.config.name)) {
    results.push({ task: item.task.id, config: item.config.name, round: item.round, status: "unsupported" });
    continue;
  }
  const r = await runOne(item);
  if (r.status === "unsupported") unsupported.set(item.config.name, r.detail);
  results.push(r);
  const what =
    r.status === "ok" || r.status === "failed"
      ? `${r.status === "ok" ? "ok" : `FAILED (${r.detail})`} ${r.wallMs} ms, ${r.calls} calls, ~${r.tokens} tokens, ${r.peakMiB} MiB`
      : `${r.status.toUpperCase()} (${r.detail})`;
  log(`[${i + 1}/${plan.length}] round ${item.round + 1} ${item.task.id} ${item.config.name}: ${what}`);
}

const measured = (r) => r.status === "ok" || r.status === "failed";
const METRICS = ["wallMs", "calls", "errors", "tokens", "peakMiB"];

function cell(task, config) {
  const runs = results.filter((r) => r.task === task && r.config === config && measured(r));
  const out = { runs: runs.length, ok: runs.filter((r) => r.status === "ok").length };
  for (const m of METRICS) out[m] = median(runs.map((r) => r[m]));
  return out;
}

function pairsOf(task, metric) {
  const out = [];
  for (let round = 0; round < rounds; round++) {
    const find = (c) => results.find((r) => r.task === task && r.config === c && r.round === round && measured(r));
    const a = find(configs[0].name);
    const b = find(configs[1].name);
    if (a && b) out.push({ a: a[metric], b: b[metric] });
  }
  return out;
}

function totalsPairs(metric) {
  const out = [];
  for (let round = 0; round < rounds; round++) {
    const sum = (c) => {
      const rs = tasks.map((t) =>
        results.find((r) => r.task === t.id && r.config === c && r.round === round && measured(r)),
      );
      if (rs.some((r) => !r)) return undefined;
      return metric === "peakMiB" ? Math.max(...rs.map((r) => r[metric])) : rs.reduce((n, r) => n + r[metric], 0);
    };
    const a = sum(configs[0].name);
    const b = sum(configs[1].name);
    if (a !== undefined && b !== undefined) out.push({ a, b });
  }
  return out;
}

const seed = Number(values.seed);
const summary = {
  cells: Object.fromEntries(
    tasks.map((t) => [t.id, Object.fromEntries(configs.map((c) => [c.name, cell(t.id, c.name)]))]),
  ),
};
if (configs.length === 2) {
  summary.paired = {};
  for (const t of tasks) {
    summary.paired[t.id] = Object.fromEntries(METRICS.map((m) => [m, paired(pairsOf(t.id, m), { seed })]));
  }
  summary.paired.all = Object.fromEntries(METRICS.map((m) => [m, paired(totalsPairs(m), { seed })]));
}

const firstBrowser = results.find((r) => r.browser)?.browser;
const report = {
  version: 1,
  kind: "turno-browser-eval",
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  machine: {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? "unknown",
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
  },
  node: process.version,
  browser: firstBrowser,
  headed: values.headed,
  rounds,
  tasks: tasks.map((t) => ({ id: t.id, title: t.title })),
  configs: configs.map((c) => ({
    ...c,
    bin: c.bin ? "(another build)" : undefined,
    versions: buildVersions(c.bin ?? DEFAULT_BIN),
  })),
  unsupported: Object.fromEntries(unsupported),
  results,
  summary,
};

if (values.out) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);

const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "-");

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows
    .map((r) =>
      r
        .map((c, i) => String(c).padEnd(widths[i]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function deltaCell(p) {
  if (!p || !p.n) return "-";
  const rel = p.relative === undefined ? "" : ` (${p.relative > 0 ? "+" : ""}${Math.round(p.relative * 100)}%)`;
  const ci = p.interval ? ` [${fmt(p.interval[0])}, ${fmt(p.interval[1])}]` : "";
  return `${p.delta > 0 ? "+" : ""}${fmt(p.delta)}${rel} ${p.lower}/${p.higher}${ci}`;
}

if (values.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const v = report.configs[0].versions;
  console.log(
    `\nturno-browser ${v.turnoBrowser ?? "?"} (patchright-core ${v.patchrightCore ?? "?"}), ${firstBrowser ?? "browser unknown"}, ${values.headed ? "headed" : "headless"}, ${rounds} round(s), medians:\n`,
  );
  const rows = [["TASK", "CONFIG", "OK", "CALLS", "ERRORS", "WALL ms", "TOKENS", "PEAK MiB"]];
  for (const t of tasks) {
    for (const [j, c] of configs.entries()) {
      const s = summary.cells[t.id][c.name];
      if (unsupported.has(c.name)) {
        rows.push([j ? "" : t.id, c.name, "unsupported", "", "", "", "", ""]);
        continue;
      }
      rows.push([
        j ? "" : t.id,
        c.name,
        `${s.ok}/${s.runs}`,
        fmt(s.calls),
        fmt(s.errors),
        fmt(s.wallMs),
        fmt(s.tokens),
        fmt(s.peakMiB),
      ]);
    }
  }
  console.log(table(rows));
  if (summary.paired && !unsupported.size) {
    console.log(
      `\n${configs[1].name} minus ${configs[0].name}, median of paired differences (relative to A), then pairs where B was lower/higher${rounds >= 5 ? ", then a 95% bootstrap interval" : ""}:\n`,
    );
    const prow = [["TASK", "WALL ms", "CALLS", "TOKENS", "PEAK MiB"]];
    for (const id of [...tasks.map((t) => t.id), "all"]) {
      const p = summary.paired[id];
      prow.push([id, deltaCell(p.wallMs), deltaCell(p.calls), deltaCell(p.tokens), deltaCell(p.peakMiB)]);
    }
    console.log(table(prow));
    if (rounds < 5) console.log("\nUse --rounds 5 or more before trusting a difference.");
  }
  for (const [name, why] of unsupported) console.log(`\n${name}: not supported by this server (${why})`);
  const failed = results.filter((r) => r.status === "failed" || r.status === "error");
  if (failed.length) {
    console.log("\nFailed runs:");
    for (const r of failed) console.log(`  round ${r.round + 1} ${r.task} ${r.config}: ${r.detail}`);
  }
}

process.exit(results.some((r) => r.status === "failed" || r.status === "error") ? 1 : 0);

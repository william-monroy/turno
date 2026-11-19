// Unit tests for the evaluation suite's pure parts. Run by `pnpm check` (node --test); no
// browser, no network.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUILTIN, configProblems, knownConfigs, readConfigsFile, resolveConfig } from "./lib/configs.mjs";
import { compareDetector, publicDetectorsAllowed } from "./lib/public.mjs";
import { runProcesses } from "./lib/server.mjs";
import { bootstrapMedian, estimateTokens, median, paired, schedule } from "./lib/stats.mjs";
import { TASKS, parseTabs, pickTasks, refOf } from "./lib/tasks.mjs";

test("median handles odd, even, empty and non-finite input", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.ok(Number.isNaN(median([])));
  assert.equal(median([1, Number.NaN, 3]), 2);
});

test("schedule alternates which configuration goes first, round by round", () => {
  const plan = schedule(["t1", "t2"], ["A", "B"], 3);
  assert.deepEqual(
    plan.map((p) => `${p.round}${p.task}${p.config}`),
    ["0t1A", "0t1B", "0t2A", "0t2B", "1t1B", "1t1A", "1t2B", "1t2A", "2t1A", "2t1B", "2t2A", "2t2B"],
  );
  assert.equal(schedule(["t"], ["A"], 2).length, 2);
});

test("paired compares runs of the same round and counts which side was lower", () => {
  const p = paired([
    { a: 100, b: 80 },
    { a: 120, b: 90 },
    { a: 110, b: 115 },
  ]);
  assert.equal(p.n, 3);
  assert.equal(p.a, 110);
  assert.equal(p.delta, -20);
  assert.equal(p.lower, 2);
  assert.equal(p.higher, 1);
  assert.equal(p.interval, undefined, "no interval under five pairs");
});

test("the bootstrap interval is reproducible with a seed and brackets the median", () => {
  const diffs = [-30, -25, -20, -22, -28, -18, -35];
  const one = bootstrapMedian(diffs, { seed: 7 });
  assert.deepEqual(one, bootstrapMedian(diffs, { seed: 7 }));
  assert.ok(one[0] <= median(diffs) && median(diffs) <= one[1]);
});

test("tokens are estimated at four bytes each", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(401), 101);
});

test("built-in configurations are valid and resolvable", () => {
  for (const c of BUILTIN) assert.deepEqual(configProblems(c), [], c.name);
  const known = knownConfigs();
  assert.equal(resolveConfig("settle-100", known).identity.settle, "100ms");
  assert.throws(() => resolveConfig("nope", known), /unknown configuration "nope" \(known: default/);
});

test("a configurations file adds entries, replaces built-ins and resolves bin next to it", () => {
  const dir = mkdtempSync(join(tmpdir(), "turno-eval-test-"));
  try {
    const file = join(dir, "configs.json");
    writeFileSync(
      file,
      JSON.stringify({
        configs: [
          { name: "main", bin: "main/dist/bin/mcp.js" },
          { name: "default", args: ["--max-tabs", "2"] },
        ],
      }),
    );
    const known = knownConfigs(readConfigsFile(file));
    assert.equal(known.get("main").bin, join(dir, "main/dist/bin/mcp.js"));
    assert.deepEqual(known.get("default").args, ["--max-tabs", "2"]);
    writeFileSync(file, JSON.stringify([{ name: "Bad Name", extra: 1 }]));
    assert.throws(() => readConfigsFile(file), /kebab-case, like settle-100; unknown key "extra"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SNAPSHOT = `- generic [active] [ref=e1]:
  - heading "Create your account" [level=1] [ref=e2]
  - textbox "Email" [ref=e5]
  - radio "Email" [ref=e9]
  - button "Create account" [ref=e12] [cursor=pointer]
  - iframe [ref=e20]:
    - button "Pay now" [ref=f2e3]`;

test("refOf finds a ref by role and exact name, including inside frames", () => {
  assert.equal(refOf(SNAPSHOT, "textbox", "Email"), "e5");
  assert.equal(refOf(SNAPSHOT, "radio", "Email"), "e9");
  assert.equal(refOf(SNAPSHOT, "button", "Create account"), "e12");
  assert.equal(refOf(SNAPSHOT, "button", "Pay now"), "f2e3");
  assert.throws(() => refOf(SNAPSHOT, "button", "Create"), /no button "Create"/);
});

test("parseTabs reads browser_tabs output", () => {
  const tabs = parseTabs(
    "### Result\n- 0: (current) [Main](http://127.0.0.1:1/)\n- 1: [Report 1](http://127.0.0.1:1/r/1)",
  );
  assert.deepEqual(tabs, [
    { index: 0, current: true, title: "Main", url: "http://127.0.0.1:1/" },
    { index: 1, current: false, title: "Report 1", url: "http://127.0.0.1:1/r/1" },
  ]);
});

test("pickTasks keeps the suite's order and refuses unknown ids", () => {
  assert.deepEqual(
    pickTasks(["frames", "form"]).map((t) => t.id),
    ["form", "frames"],
  );
  assert.ok(pickTasks([], { smoke: true }).every((t) => t.smoke));
  assert.equal(pickTasks([]).length, TASKS.length);
  assert.throws(() => pickTasks(["nope"]), /unknown task "nope"/);
});

test("runProcesses picks the server, its descendants and processes that name the HOME", () => {
  const ps = [
    "  10     1  1000 node server.js",
    "  11    10  2000 chrome --user-data-dir=/tmp/h/profile",
    "  12    11   500 chrome helper",
    "  13     1   300 chrome --user-data-dir=/tmp/h/profile --type=crashpad",
    "  14     1  9999 unrelated",
  ].join("\n");
  assert.deepEqual(
    runProcesses(ps, 10, "/tmp/h")
      .map((p) => p.pid)
      .sort(),
    [10, 11, 12, 13],
  );
  assert.deepEqual(
    runProcesses(ps, -1, "/tmp/h").map((p) => p.pid),
    [11, 13],
  );
});

test("public detector pages need the opt-in variable", () => {
  assert.equal(publicDetectorsAllowed({}), false);
  assert.equal(publicDetectorsAllowed({ TURNO_BENCH_PUBLIC_DETECTORS: "true" }), false);
  assert.equal(publicDetectorsAllowed({ TURNO_BENCH_PUBLIC_DETECTORS: "1" }), true);
});

test("detector results are compared with plain Chrome by failed test name and network fingerprint", () => {
  const ref = { failed: ["headless"], score: { failed: 1 } };
  assert.equal(compareDetector("rebrowser", { failed: [], score: { failed: 0 } }, ref).status, "pass");
  const worse = compareDetector("rebrowser", { failed: ["storagePartitioning"] }, ref);
  assert.equal(worse.status, "warn");
  assert.match(worse.note, /storagePartitioning/);
  const tls = { score: { ja4: "t13d", akamai: "52d8" } };
  assert.equal(compareDetector("tls", tls, tls).status, "pass");
  assert.equal(compareDetector("tls", { score: { ja4: "t13x", akamai: "52d8" } }, tls).status, "fail");
  assert.equal(compareDetector("tls", tls, { error: "offline" }), undefined);
});

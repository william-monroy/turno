#!/usr/bin/env node
// Renders the VHS tapes in tapes/ into text recordings the site shows (content/recordings).
//
//   node scripts/render-tapes.mjs            every tape
//   node scripts/render-tapes.mjs doctor     one tape
//
// Needs vhs (with ttyd and ffmpeg) and a built CLI (pnpm build at the repository root). Every
// tape starts in the clean shell of docs/demo/setup.sh and runs `turno demo`, so everything
// happens in throwaway HOMEs under /tmp: your own HOME, config and accounts are never read.
// A tape writes the frames of its terminal as text; this script keeps the last frame, up to the
// `exit` that leaves the demo shell. Ports, pids and times differ between runs, so the result
// is committed rather than compared in CI; CI renders the tapes to prove they still run.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(APP, "../..");
const TMP = join(APP, ".tmp");
const OUT = join(APP, "content/recordings");
const RULE = /^─{20,}$/;

if (!existsSync(join(ROOT, "packages/turno/dist/cli/main.js"))) {
  console.error("render-tapes: build first: pnpm build");
  process.exit(1);
}
const only = process.argv.slice(2);
const tapes = readdirSync(join(APP, "tapes"))
  .filter((f) => f.endsWith(".tape"))
  .map((f) => f.slice(0, -".tape".length))
  .filter((name) => !only.length || only.includes(name));
if (!tapes.length) {
  console.error(`render-tapes: no tape matches ${only.join(", ")}`);
  process.exit(1);
}
mkdirSync(TMP, { recursive: true });
mkdirSync(OUT, { recursive: true });

let failed = false;
for (const name of tapes) {
  const raw = join(TMP, `${name}.txt`);
  rmSync(raw, { force: true });
  const res = spawnSync("vhs", [`apps/docs/tapes/${name}.tape`], { cwd: ROOT, encoding: "utf8" });
  if (res.status !== 0 || !existsSync(raw)) {
    console.error(`render-tapes: ${name}.tape failed\n${res.stdout ?? ""}${res.stderr ?? ""}${res.error ?? ""}`);
    failed = true;
    continue;
  }
  // Frames are separated by a rule; the last one holds the whole session.
  const frames = [[]];
  for (const line of readFileSync(raw, "utf8").split("\n")) {
    if (RULE.test(line)) frames.push([]);
    else frames.at(-1).push(line.trimEnd());
  }
  let lines = frames.filter((f) => f.some((l) => l)).at(-1) ?? [];
  const exit = lines.findIndex((l) => /[%$] exit$/.test(l));
  if (exit < 0) {
    console.error(`render-tapes: ${name}.tape did not reach its exit; raise the tape's Height or its waits`);
    failed = true;
    continue;
  }
  lines = lines.slice(0, exit);
  while (lines.length && !lines.at(-1)) lines.pop();
  while (lines.length && !lines[0]) lines.shift();
  const text = lines.join("\n").replace(/turno-demo-[A-Za-z0-9]{6}/g, "turno-demo-Xk3f9a");
  const leaks = [homedir(), userInfo().username].filter((s) => s && s !== "demo" && s !== "runner" && text.includes(s));
  if (leaks.length || /^\s*$/.test(text)) {
    console.error(`render-tapes: ${name}.tape ${leaks.length ? "shows something of this machine" : "is empty"}; not written`);
    failed = true;
    continue;
  }
  writeFileSync(join(OUT, `${name}.txt`), `${text}\n`);
  console.log(`rendered ${name} (${lines.length} lines)`);
}
rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

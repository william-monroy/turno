import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chromeUnavailable, stopSandboxProcesses } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The smoke subset of the evaluation suite and the fingerprint bench (bench/browser), run as a
 * user runs them, against the built server and a real headless Chrome. The full suite and the
 * A/B comparisons run locally (`pnpm bench:browser`); this guards the tasks and the signals
 * that must never regress after a Patchright or Chrome update. Skipped when Chrome is missing or
 * cannot start (or with TURNO_SKIP_CHROME=1).
 */

const root = fileURLToPath(new URL("../../..", import.meta.url));
const reason = chromeUnavailable();

let sb: Sandbox;
// The runs keep the system TMPDIR, as the other Chrome tests do: a deeper one makes the path of
// Playwright's socket too long. The scripts delete their throwaway folders, also on SIGTERM.
beforeEach(() => {
  sb = sandbox();
});
afterEach(async () => {
  await stopSandboxProcesses(sb.home);
  sb.cleanup();
});

function run(script: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(root, "bench/browser", script), ...args],
      { env: sb.env, cwd: sb.home, timeout: 200_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

interface EvalRun {
  task: string;
  status: string;
  detail?: string;
  calls: number;
}

interface Check {
  id: string;
  status: string;
}

describe.skipIf(reason)(`evaluation smoke${reason ? ` (skipped: ${reason})` : ""}`, () => {
  it("runs the smoke tasks through the real server and every one succeeds", { timeout: 240_000 }, async () => {
    const res = await run("eval.mjs", ["--smoke", "--json"]);
    const report = JSON.parse(res.stdout) as { results: EvalRun[] };
    const failed = report.results.filter((r) => r.status !== "ok").map((r) => `${r.task}: ${r.status} ${r.detail}`);
    expect(failed, res.stderr).toEqual([]);
    expect(report.results.map((r) => r.task)).toEqual(["form", "overlay", "shadow", "frames"]);
    expect(report.results.every((r) => r.calls > 0)).toBe(true);
    expect(res.code).toBe(0);
  });

  it("finds no automation markers on the probe page", { timeout: 240_000 }, async () => {
    const res = await run("fingerprint.mjs", ["--json", "--no-reference"]);
    const report = JSON.parse(res.stdout) as { configs: { status: string; checks: Check[] }[] };
    const [cfg] = report.configs;
    expect(cfg?.status, res.stderr).toBe("ran");
    const status = Object.fromEntries(cfg!.checks.map((c) => [c.id, c.status]));
    for (const id of [
      "webdriver",
      "automation-globals",
      "client-hints-match",
      "csp-enforced",
      "main-world-calls",
      "legacy-runtime-leak",
      "events-trusted",
      "focus-before-keys",
    ]) {
      expect(status[id], id).toBe("pass");
    }
    expect(res.code).toBe(0);
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { detectChallenge, parseRebrowser, parseSannysoft } from "./detectors.js";
import { paths } from "./paths.js";
import { resolveFrom } from "./patchright.js";

/**
 * `turno browser bench`: runs several browser engines against public bot detectors and the
 * user's own URLs, so engine choices rest on measurements (ADR 0003, 0005).
 */

/**
 * Engine ids name the browser and its mode: Chrome headed and headless through the package's
 * own Playwright build, Chrome through stock Playwright as the baseline to compare with, and
 * Firefox (optional, never installed automatically).
 */
export const ENGINES = ["chrome-headed", "chrome-headless", "chrome-baseline", "firefox"] as const;
export type EngineName = (typeof ENGINES)[number];

/** The ids engines had in turno-browser 0.1, still accepted so scripts keep working. */
export const ENGINE_ALIASES: Readonly<Record<string, EngineName>> = Object.freeze({
  "patchright-chrome-headed": "chrome-headed",
  "patchright-chrome-headless": "chrome-headless",
  "playwright-stock": "chrome-baseline",
  camoufox: "firefox",
});

/** The engine a name stands for (a current id or an old one), or undefined when unknown. */
export function engineId(name: string): EngineName | undefined {
  if ((ENGINES as readonly string[]).includes(name)) return name as EngineName;
  return Object.hasOwn(ENGINE_ALIASES, name) ? ENGINE_ALIASES[name] : undefined;
}

export const DETECTORS = {
  rebrowser: "https://bot-detector.rebrowser.net/",
  sannysoft: "https://bot.sannysoft.com/",
} as const;

export interface BenchOptions {
  /** Engines to run. Default: both Chrome engines, plus the optional ones when installed. */
  engines?: EngineName[];
  /** Extra URLs to check for challenges. */
  urls?: string[];
  /** Run the public detectors (default true). */
  detectors?: boolean;
  /** Write the JSON report under <state>/bench (default true). */
  write?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Milliseconds to let detector scripts finish after load (default 5000). */
  settleMs?: number;
  onProgress?: (message: string) => void;
}

export interface EngineReport {
  engine: EngineName;
  status: "ran" | "skipped" | "error";
  reason?: string;
}

export interface TargetResult {
  engine: EngineName;
  target: "rebrowser" | "sannysoft" | "url";
  url: string;
  ok: boolean;
  summary: string;
  error?: string;
  details?: unknown;
}

export interface BenchReport {
  version: 1;
  startedAt: string;
  finishedAt: string;
  engines: EngineReport[];
  results: TargetResult[];
  /** Where the JSON was written, when it was. */
  file?: string;
}

interface PageLike {
  goto(url: string, options?: { timeout?: number; waitUntil?: "load" }): Promise<{ status(): number } | null>;
  content(): Promise<string>;
  waitForTimeout(ms: number): Promise<void>;
}

interface Session {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

interface LaunchableChromium {
  launchPersistentContext(dir: string, options: Record<string, unknown>): Promise<{ newPage(): Promise<PageLike>; close(): Promise<void> }>;
}

async function importResolved(name: string): Promise<Record<string, unknown>> {
  const file = resolveFrom(name);
  if (!file) throw new Error(`${name} is not installed`);
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
}

async function persistentChrome(chromium: LaunchableChromium, headless: boolean): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), "turno-bench-"));
  try {
    const ctx = await chromium.launchPersistentContext(dir, { channel: "chrome", headless, viewport: null });
    return {
      newPage: () => ctx.newPage(),
      close: async () => {
        await ctx.close().catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function chromiumOf(mod: Record<string, unknown>): LaunchableChromium {
  const chromium = (mod.chromium ?? (mod.default as Record<string, unknown> | undefined)?.chromium) as LaunchableChromium | undefined;
  if (!chromium) throw new Error("module has no chromium export");
  return chromium;
}

/** Why an optional engine cannot run, or undefined when it can. */
export function unavailableReason(engine: EngineName): string | undefined {
  if (engine === "chrome-baseline" && !resolveFrom("playwright-core")) return "playwright-core is not installed";
  if (engine === "firefox" && !resolveFrom("camoufox-js")) return "camoufox-js is not installed; it is never installed automatically";
  return undefined;
}

async function launch(engine: EngineName): Promise<Session> {
  switch (engine) {
    case "chrome-headed":
      return persistentChrome(chromiumOf(await importResolved("patchright-core")), false);
    case "chrome-headless":
      return persistentChrome(chromiumOf(await importResolved("patchright-core")), true);
    case "chrome-baseline":
      return persistentChrome(chromiumOf(await importResolved("playwright-core")), true);
    case "firefox": {
      const mod = await importResolved("camoufox-js");
      const Camoufox = (mod.Camoufox ?? (mod.default as Record<string, unknown> | undefined)?.Camoufox) as
        | ((o: Record<string, unknown>) => Promise<{ newPage(): Promise<PageLike>; close(): Promise<void> }>)
        | undefined;
      if (!Camoufox) throw new Error("camoufox-js has no Camoufox export");
      const browser = await Camoufox({ headless: true });
      return { newPage: () => browser.newPage(), close: () => browser.close().catch(() => undefined) };
    }
  }
}

/** Default engine list: both Chrome engines, plus optional ones that are installed. */
export function defaultEngines(): EngineName[] {
  return ENGINES.filter((e) => e === "chrome-headed" || e === "chrome-headless" || !unavailableReason(e));
}

async function runTarget(
  session: Session,
  engine: EngineName,
  target: TargetResult["target"],
  url: string,
  settleMs: number,
): Promise<TargetResult> {
  const page = await session.newPage();
  const response = await page.goto(url, { timeout: 45_000, waitUntil: "load" });
  await page.waitForTimeout(target === "url" ? Math.min(settleMs, 3000) : settleMs);
  const html = await page.content();
  if (target === "rebrowser") {
    const r = parseRebrowser(html);
    const failed = r.tests.filter((t) => t.status === "fail").map((t) => t.name);
    const warned = r.tests.filter((t) => t.status === "warn").map((t) => t.name);
    const parts = [`${r.passed} pass`, `${r.failed} fail${failed.length ? ` (${failed.join(", ")})` : ""}`];
    if (warned.length) parts.push(`${r.warned} warn (${warned.join(", ")})`);
    if (!r.tests.length) parts.splice(0, parts.length, "no results table found");
    return { engine, target, url, ok: r.tests.length > 0 && r.failed === 0, summary: parts.join(", "), details: r };
  }
  if (target === "sannysoft") {
    const r = parseSannysoft(html);
    const summary = r.rows.length
      ? `${r.failed} failed of ${r.rows.length}${r.failed ? ` (${r.failedNames.join(", ")})` : ""}`
      : "no result rows found";
    return { engine, target, url, ok: r.rows.length > 0 && r.failed === 0, summary, details: r };
  }
  const status = response?.status() ?? 0;
  const c = detectChallenge(html);
  const challenge = c.markers.length ? `challenge: ${c.markers.join(", ")}` : "no challenge markers";
  return {
    engine,
    target,
    url,
    ok: status > 0 && status < 400 && c.markers.length === 0,
    summary: `${status || "no response"} "${c.title}" ${challenge}`,
    details: { status, title: c.title, markers: c.markers },
  };
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

export async function runBench(options: BenchOptions = {}): Promise<BenchReport> {
  const env = options.env ?? process.env;
  const settleMs = options.settleMs ?? 5000;
  const log = options.onProgress ?? (() => undefined);
  const engines = options.engines?.length ? options.engines : defaultEngines();
  const targets: { target: TargetResult["target"]; url: string }[] = [];
  if (options.detectors !== false) {
    targets.push({ target: "rebrowser", url: DETECTORS.rebrowser }, { target: "sannysoft", url: DETECTORS.sannysoft });
  }
  for (const url of options.urls ?? []) targets.push({ target: "url", url });

  const started = new Date();
  const report: BenchReport = { version: 1, startedAt: started.toISOString(), finishedAt: "", engines: [], results: [] };
  for (const engine of engines) {
    const reason = unavailableReason(engine);
    if (reason) {
      report.engines.push({ engine, status: "skipped", reason });
      log(`${engine}: skipped (${reason})`);
      continue;
    }
    let session: Session;
    try {
      log(`${engine}: launching`);
      session = await launch(engine);
    } catch (err) {
      report.engines.push({ engine, status: "error", reason: firstLine(err) });
      log(`${engine}: failed to launch (${firstLine(err)})`);
      continue;
    }
    report.engines.push({ engine, status: "ran" });
    try {
      for (const t of targets) {
        log(`${engine}: ${t.url}`);
        try {
          report.results.push(await runTarget(session, engine, t.target, t.url, settleMs));
        } catch (err) {
          report.results.push({ engine, target: t.target, url: t.url, ok: false, summary: "error", error: firstLine(err) });
        }
      }
    } finally {
      await session.close();
    }
  }
  report.finishedAt = new Date().toISOString();
  if (options.write !== false) {
    const dir = paths(env).benchDir;
    mkdirSync(dir, { recursive: true });
    report.file = join(dir, `${stamp(started)}.json`);
    writeFileSync(report.file, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

function firstLine(err: unknown): string {
  return String((err as Error)?.message ?? err).split("\n")[0]!;
}

/** Plain-text table of a report: one row per engine and target, plus skipped engines. */
export function formatBenchTable(report: BenchReport): string {
  const rows: string[][] = [["ENGINE", "TARGET", "RESULT", "DETAILS"]];
  for (const r of report.results) {
    const target = r.target === "url" ? r.url : r.target;
    rows.push([r.engine, target, r.error ? "ERROR" : r.ok ? "PASS" : "FAIL", r.error ?? r.summary]);
  }
  for (const e of report.engines) {
    if (e.status !== "ran") rows.push([e.engine, "-", e.status.toUpperCase(), e.reason ?? ""]);
  }
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows
    .map((r) => r.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]!) : cell)).join("  ").trimEnd())
    .join("\n");
}

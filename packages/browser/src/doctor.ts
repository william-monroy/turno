import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { browserPaths as paths } from "turno-core/paths";
import { type ProcTable, readProcTable, signalProcess } from "turno-core/process";
import { readHealth } from "./health.js";
import { identityDir, isValidIdentityId } from "./ids.js";
import { defaultChromeUserDataDir, parseAttachTarget, resolveAttachEndpoint } from "./engine-attach.js";
import {
  type LightpandaInfo,
  findLightpanda,
  findOrphanLightpandas,
  lightpandaCookieJar,
  lightpandaInstallHint,
} from "./engine-lightpanda.js";
import { findProfileChrome, sweepOrphan } from "./lifecycle.js";
import { readChallenges, summarizeChallenges } from "./reputation.js";
import { inUseMessage, readRuntimeLock, runtimeLockAlive, runtimeLockPath } from "./runtime-lock.js";
import { type IdentitySettings, acceptLanguages, checkIdentitySettings, systemTimezone } from "./settings.js";

/**
 * `turno browser doctor`: what a browser identity needs to work, one check per row,
 * each problem with the command that fixes it, like `turno doctor`.
 *
 * - Chrome: found, its version, and a smoke launch on a throwaway profile (headless).
 * - System: a headed Chrome needs the desktop session (macOS) or a display (Linux).
 * - Engines: Lightpanda for read mode (optional; a failure only when an identity uses it), and
 *   a Lightpanda an earlier server left running.
 * - Per identity: identity.json, who holds it (runtime lock and Chrome's profile lock), session
 *   health, and challenges in the last 7 days.
 *
 * `--fix` removes runtime locks whose process is gone and stops a Chrome an earlier run left
 * behind on an identity's profile (the same sweep a server start does), and stops a Lightpanda
 * an earlier server left running.
 */

export interface DoctorCheck {
  /** "chrome", "system", "engines", "identities" or "identity <id>". */
  area: string;
  level: "ok" | "warn" | "fail" | "info";
  text: string;
  /** The command that fixes it, which a person runs (or `--fix` runs, with `auto`). */
  fix?: string;
  /** True when `turno browser doctor --fix` runs `fix`. */
  auto?: boolean;
  /** The manual step, when no single command fixes it. */
  manual?: string;
}

export interface ChromeInfo {
  path: string;
  version?: string;
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Run the smoke launch (default true). */
  launch?: boolean;
  /** Repair what is safe to repair, then check again. */
  fix?: boolean;
  /** Finds Chrome (tests inject one). */
  chrome?: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => ChromeInfo | undefined;
  /** Starts and closes Chrome on a temporary profile; resolves with the milliseconds it took. */
  smoke?: (env: NodeJS.ProcessEnv) => Promise<number>;
  /** Finds Lightpanda (tests inject one). */
  lightpanda?: (env: NodeJS.ProcessEnv) => LightpandaInfo | undefined;
  /** The process table, for a Lightpanda left running (tests inject one). */
  procTable?: () => ProcTable | undefined;
  now?: Date;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** What `--fix` did. */
  fixed: string[];
}

const FIX = "turno browser doctor --fix";

const CHROME_PATHS = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] => {
  const home = paths(env).home;
  if (platform === "darwin")
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    ];
  if (platform === "win32") {
    return [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]]
      .filter(Boolean)
      .map((root) => join(root!, "Google", "Chrome", "Application", "chrome.exe"));
  }
  return ["/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
};

/** CFBundleShortVersionString of a macOS Info.plist (XML). */
export function chromeVersionFromPlist(xml: string): string | undefined {
  return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)?.[1]?.trim();
}

/** The installed Google Chrome (the `chrome` channel Playwright launches) and its version. */
export function findChrome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ChromeInfo | undefined {
  const path = CHROME_PATHS(env, platform).find((p) => existsSync(p));
  if (!path) return undefined;
  let version: string | undefined;
  try {
    if (platform === "darwin")
      version = chromeVersionFromPlist(readFileSync(join(dirname(dirname(path)), "Info.plist"), "utf8"));
    else
      version = /(\d+\.\d+\.\d+\.\d+)/.exec(
        execFileSync(path, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }),
      )?.[1];
  } catch {
    /* found, version unknown */
  }
  return version ? { path, version } : { path };
}

/** Starts Chrome headless on a throwaway profile, opens a blank page and closes it. */
async function smokeLaunch(env: NodeJS.ProcessEnv): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "turno-browser-doctor-"));
  const t0 = Date.now();
  try {
    const { chromium } = await import("patchright-core");
    const context = await chromium.launchPersistentContext(join(dir, "profile"), {
      channel: "chrome",
      headless: true,
      timeout: 30_000,
      env: { ...env } as Record<string, string>,
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto("about:blank");
    } finally {
      await context.close();
    }
    return Date.now() - t0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const firstLine = (e: unknown) => String((e as Error).message ?? e).split("\n")[0]!;

function systemChecks(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  if (platform === "darwin") {
    out.push({
      area: "system",
      level: "ok",
      text: "macOS: driving Chrome through its DevTools pipe needs no Accessibility or Screen Recording permission",
    });
    if (env.SSH_CONNECTION || env.SSH_TTY) {
      out.push({
        area: "system",
        level: "warn",
        text: "this is an SSH session: a headed Chrome opens only in the signed-in desktop session (where mcpd runs)",
        manual: "run the browser through mcpd, or pass --headless when you start turno-browser-mcp here",
      });
    }
  } else if (platform === "linux") {
    if (env.DISPLAY || env.WAYLAND_DISPLAY)
      out.push({
        area: "system",
        level: "ok",
        text: `display: ${env.WAYLAND_DISPLAY ? `Wayland ${env.WAYLAND_DISPLAY}` : `X11 ${env.DISPLAY}`}`,
      });
    else
      out.push({
        area: "system",
        level: "warn",
        text: "no display: a headed Chrome cannot open here",
        manual: "pass --headless to turno-browser-mcp, or run it inside a desktop session",
      });
  }
  return out;
}

function describeSettings(s: IdentitySettings): string {
  const parts: string[] = [];
  if (s.timezone) parts.push(`time zone ${s.timezone}`);
  const langs = acceptLanguages(s);
  if (langs) parts.push(`languages ${langs.join(", ")}`);
  if (s.region) parts.push(`region ${s.region}`);
  return parts.length ? parts.join(", ") : "no fixed time zone or languages";
}

/** The `turno identity set` flag that replaces the value a problem is about. */
function settingsFix(id: string, problem: string): string | undefined {
  const flag = (
    [
      ["timezone", "--timezone <zone>"],
      ["locale", "--locale <tag>"],
      ["languages", "--languages <tag,...>"],
      ["region", "--region <CC>"],
      ["health", "--health-url <url> --health-text <text>"],
    ] as const
  ).find(([key]) => problem.startsWith(key))?.[1];
  return flag ? `turno identity set browser:${id} ${flag}` : undefined;
}

function identityChecks(id: string, env: NodeJS.ProcessEnv, now: Date): DoctorCheck[] {
  const area = `identity ${id}`;
  const out: DoctorCheck[] = [];
  const add = (c: Omit<DoctorCheck, "area">) => out.push({ area, ...c });

  const { path, settings, problems } = checkIdentitySettings(id, env);
  if (problems.length) {
    const fix = settingsFix(id, problems[0]!);
    add({
      level: "fail",
      text: `identity.json ${problems[0]!.startsWith("is ") ? problems[0] : `is invalid: ${problems.join("; ")}`}`,
      ...(fix ? { fix } : {}),
      manual: problems[0]!.startsWith("is format")
        ? "update turno-browser: npm install --global turno-browser@latest"
        : `edit or delete ${path}`,
    });
  } else if (!settings) {
    add({
      level: "info",
      text: "no identity.json: Chrome's own time zone and languages, which follow this computer",
      fix: `turno identity set browser:${id} --timezone ${systemTimezone()}`,
    });
  } else {
    add({ level: "ok", text: `identity.json: ${describeSettings(settings)}` });
  }

  if (settings) for (const c of engineRows(id, settings, env)) add(c);

  const lock = readRuntimeLock(id, env);
  const chrome = findProfileChrome(identityDir(id, env));
  if (lock && runtimeLockAlive(lock)) {
    add({
      level: "ok",
      text: inUseMessage(id, lock)
        .replace(/^browser identity "[^"]+" is /, "")
        .replace(/\. .*$/, ""),
    });
  } else if (chrome?.owner === "orphan") {
    add({
      level: "warn",
      text: `Chrome pid ${chrome.pid} was left running on this profile with no server`,
      fix: FIX,
      auto: true,
    });
  } else if (chrome) {
    add({
      level: "warn",
      text: `Chrome pid ${chrome.pid} holds this profile, but no turno process does`,
      manual: "close that Chrome window (a Chrome opened by hand, or a login of an older turno)",
    });
  } else if (lock) {
    add({
      level: "warn",
      text: `stale runtime lock of pid ${lock.nodePid} (that process is gone)`,
      fix: FIX,
      auto: true,
    });
  } else {
    add({ level: "ok", text: "free: no process holds it" });
  }

  const check = settings?.health;
  const health = readHealth(id, env);
  if (!check) {
    add({
      level: "info",
      text: "no session health check: a signed-out session shows up only when a page asks to sign in",
      fix: `turno identity set browser:${id} --health-url <url> --health-text <text>`,
    });
  } else if (!health || health.url !== check.url) {
    add({ level: "info", text: `health check of ${check.url}: not run yet (it runs when the browser starts)` });
  } else if (health.status === "ok") {
    add({ level: "ok", text: `signed in at ${health.url} (checked ${health.checkedAt})` });
  } else if (health.status === "needs_auth") {
    add({
      level: "fail",
      text: `NEEDS_AUTH: not signed in at ${health.url}: ${health.detail ?? "the check failed"} (checked ${health.checkedAt})`,
      fix: `turno browser login ${id}`,
    });
  } else {
    add({
      level: "warn",
      text: `the health check of ${health.url} could not run: ${health.detail ?? "unknown error"} (checked ${health.checkedAt})`,
      manual: "check the URL and the network; the next browser start tries again",
    });
  }

  const sites = summarizeChallenges(readChallenges(id, env), now).filter((s) => s.last7d > 0);
  if (sites.length) {
    const recent = readChallenges(id, env).filter((e) => now.getTime() - Date.parse(e.ts) <= 7 * 86_400_000);
    const kinds = (["captcha", "verify", "block"] as const)
      .map((k) => [k, recent.filter((e) => e.kind === k).length] as const)
      .filter(([, n]) => n)
      .map(([k, n]) => `${n} ${k}`);
    add({
      level: "warn",
      text: `${recent.length} challenge${recent.length === 1 ? "" : "s"} in the last 7 days on ${sites.length} site${sites.length === 1 ? "" : "s"} (${kinds.join(", ")})`,
      fix: `turno browser reputation ${id}`,
    });
  }
  return out;
}

const ENABLE_DEBUGGING = "start Chrome, open chrome://inspect/#remote-debugging and turn remote debugging on";

/** What an identity's engine needs (identity.json `engine`, `attach`); none for Chrome. */
function engineRows(id: string, settings: IdentitySettings, env: NodeJS.ProcessEnv): Omit<DoctorCheck, "area">[] {
  if (settings.engine === "lightpanda")
    return [
      {
        level: "info",
        text: `read mode on Lightpanda: its own cookies in ${lightpandaCookieJar(id, env)}, not the Chrome profile`,
        fix: `turno browser set ${id} --engine chrome`,
      },
    ];
  if (settings.attach === undefined) return [];
  const target = parseAttachTarget(settings.attach);
  if ("error" in target) return [];
  try {
    const endpoint = resolveAttachEndpoint(target, env);
    return [
      {
        level: "ok",
        text: `attach: a Chrome listens at ${endpoint.replace(/\/devtools\/.*$/, "")}; it asks you to allow each new connection, and the agent then sees every window of that profile`,
      },
    ];
  } catch {
    const dir = target.kind === "dir" ? target.dir : target.kind === "auto" ? defaultChromeUserDataDir(env) : undefined;
    return [
      {
        level: "warn",
        text: `attach: no Chrome with remote debugging on${dir ? ` for ${dir}` : ""}, so the next tool call fails`,
        manual: ENABLE_DEBUGGING,
      },
    ];
  }
}

/** A `lightpanda serve` that a turno-browser-mcp started and that outlived it. */
function strayLightpandas(table: ProcTable | undefined): number[] {
  return table ? findOrphanLightpandas("any", table).map((o) => o.pid) : [];
}

function engineChecks(opts: DoctorOptions, env: NodeJS.ProcessEnv, ids: string[]): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const area = "engines";
  const lightpanda = (opts.lightpanda ?? findLightpanda)(env);
  const users = ids.filter((id) => checkIdentitySettings(id, env).settings?.engine === "lightpanda");
  const platform = opts.platform ?? process.platform;
  const hint = lightpandaInstallHint(platform);
  const install = platform === "darwin" || platform === "linux" ? { fix: hint } : { manual: hint };
  if (lightpanda)
    out.push({
      area,
      level: "ok",
      text: `Lightpanda${lightpanda.version ? ` ${lightpanda.version}` : ""} at ${lightpanda.path} (read mode)`,
    });
  else if (users.length)
    out.push({
      area,
      level: "fail",
      text: `Lightpanda not found, and read mode needs it for ${users.map((u) => `browser:${u}`).join(", ")}`,
      ...install,
    });
  else
    out.push({
      area,
      level: "info",
      text: "Lightpanda not found: only read mode (--engine lightpanda) needs it, and turno never downloads it",
      ...install,
    });
  const stray = strayLightpandas((opts.procTable ?? readProcTable)());
  if (stray.length)
    out.push({
      area,
      level: "warn",
      text: `Lightpanda pid ${stray.join(", ")} was left running by a server that is gone`,
      fix: FIX,
      auto: true,
    });
  return out;
}

/** Every identity id, including profile dirs with an identity.json only. */
function identityIds(env: NodeJS.ProcessEnv): string[] {
  try {
    return readdirSync(paths(env).identitiesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isValidIdentityId(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

async function collect(
  opts: DoctorOptions,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  now: Date,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const chrome = (opts.chrome ?? findChrome)(env, platform);
  if (chrome)
    checks.push({
      area: "chrome",
      level: "ok",
      text: `Google Chrome${chrome.version ? ` ${chrome.version}` : ""} at ${chrome.path}`,
    });
  else {
    checks.push({
      area: "chrome",
      level: "fail",
      text: "Google Chrome not found",
      manual:
        "install Google Chrome (https://www.google.com/chrome/): turno-browser drives the installed Chrome, not a bundled browser",
    });
  }
  if (opts.launch === false) checks.push({ area: "chrome", level: "info", text: "smoke launch skipped (--no-launch)" });
  else {
    try {
      const ms = await (opts.smoke ?? smokeLaunch)(env);
      checks.push({
        area: "chrome",
        level: "ok",
        text: `smoke launch: Chrome started and closed in ${(ms / 1000).toFixed(1)}s on a temporary profile`,
      });
    } catch (err) {
      checks.push({
        area: "chrome",
        level: "fail",
        text: `smoke launch failed: ${firstLine(err)}`,
        manual: "open Chrome by hand once; on Linux install its system libraries",
      });
    }
  }
  checks.push(...systemChecks(env, platform));
  const ids = identityIds(env);
  checks.push(...engineChecks(opts, env, ids));
  if (!ids.length)
    checks.push({
      area: "identities",
      level: "info",
      text: "no browser identities yet",
      fix: "turno identity add browser:<id>",
    });
  for (const id of ids) checks.push(...identityChecks(id, env, now));
  return checks;
}

/** Repairs what is safe: stale runtime locks, a Chrome left running with no server, a stray Lightpanda. */
async function repair(env: NodeJS.ProcessEnv, opts: DoctorOptions): Promise<string[]> {
  const done: string[] = [];
  for (const pid of strayLightpandas((opts.procTable ?? readProcTable)())) {
    signalProcess(pid, "SIGTERM");
    done.push(`stopped Lightpanda pid ${pid}, left running by a server that is gone`);
  }
  for (const id of identityIds(env)) {
    const lock = readRuntimeLock(id, env);
    if (lock && !runtimeLockAlive(lock)) {
      rmSync(runtimeLockPath(id, env), { force: true });
      done.push(`${id}: removed the stale runtime lock of pid ${lock.nodePid}`);
    }
    const swept = await sweepOrphan(identityDir(id, env));
    if (swept.action === "exited" || swept.action === "killed")
      done.push(`${id}: closed Chrome pid ${swept.pid}, left running with no server`);
    else if (swept.action === "survived") done.push(`${id}: Chrome pid ${swept.pid} did not stop`);
  }
  return done;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? new Date();
  let checks = await collect(opts, env, platform, now);
  const fixed: string[] = [];
  if (opts.fix && checks.some((c) => c.auto && (c.level === "warn" || c.level === "fail"))) {
    fixed.push(...(await repair(env, opts)));
    checks = await collect({ ...opts, launch: false }, env, platform, now).then((again) => {
      // Keep the smoke launch result of the first pass: it does not change with a repair.
      const smoke = checks.find((c) => c.area === "chrome" && /^smoke launch/.test(c.text));
      return smoke ? again.map((c) => (c.area === "chrome" && /^smoke launch/.test(c.text) ? smoke : c)) : again;
    });
  }
  return { checks, fixed };
}

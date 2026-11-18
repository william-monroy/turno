import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tildify } from "../../core/paths.js";
import { type FlagSpec, JSON_FLAG, type Parsed, bool, parseFlags, str } from "../args.js";
import { Exit } from "../exit.js";
import { type Io, fail } from "../io.js";
import { emit, jsonOutput } from "../output.js";
import { style } from "../style.js";
import type { BrowserApi } from "./browser.js";

/** `turno browser show --json` and `turno identity show browser:<id> --json` (ADR 0045). */
export const SHOW_JSON = jsonOutput(["id", "dir", "settingsFile", "settings", "problems", "inUse", "holder", "health"]);
/** `turno browser set --json` and `turno identity set browser:<id> --json`: what changed, or would. */
export const SET_JSON = jsonOutput(["id", "settingsFile", "dryRun", "changes", "settings"]);
/** `turno browser doctor --json`: the shape of `turno doctor --json`. */
export const DOCTOR_JSON = jsonOutput(["ok", "counts", "checks", "fixed"]);
/** `turno browser reputation --json`: one element per identity. */
export const REPUTATION_JSON = jsonOutput(["id", "file", "total", "sites"]);

/**
 * The identity module of turno-browser in the CLI (ADR 0044): identity.json (`show`, `set`, the
 * settings flags of `add`), `turno browser doctor` and `turno browser reputation`. The types
 * come from the package itself (`import type`, ADR 0047); `loadBrowser` refuses a package whose
 * API_VERSION does not fit, so every function used here is there.
 */
type IdentitySettings = NonNullable<ReturnType<BrowserApi["checkIdentitySettings"]>["settings"]>;
type HealthCheck = NonNullable<IdentitySettings["health"]>;
type TabSettings = NonNullable<IdentitySettings["tabs"]>;
type BlockSettings = NonNullable<IdentitySettings["block"]>;
type CacheSettings = NonNullable<IdentitySettings["cache"]>;
export type SettingsPatch = Parameters<BrowserApi["writeIdentitySettings"]>[1];
type DoctorCheck = Awaited<ReturnType<BrowserApi["runDoctor"]>>["checks"][number];

/** Flags that write identity.json, shared by `add` and `set`. An empty value removes the key. */
export const SETTINGS_FLAGS: FlagSpec = {
  timezone: { type: "string" },
  locale: { type: "string" },
  languages: { type: "string" },
  region: { type: "string" },
  "health-url": { type: "string" },
  "health-text": { type: "string" },
  "health-selector": { type: "string" },
  "no-health": { type: "boolean" },
  // How the host runs this identity's Chrome (format 2 of identity.json): the tab governor
  // (ADR 0048), background throttling, settle (ADR 0051), resource blocking and cache (ADR 0052).
  "tabs-max": { type: "string" },
  "tabs-popups": { type: "string" },
  "tabs-park": { type: "string" },
  "tabs-close": { type: "string" },
  "no-tabs": { type: "boolean" },
  "background-throttling": { type: "string" },
  settle: { type: "string" },
  "block-trackers": { type: "string" },
  "block-types": { type: "string" },
  "block-patterns": { type: "string" },
  "no-block": { type: "boolean" },
  cache: { type: "boolean" },
  "cache-max-size": { type: "string" },
  "no-cache": { type: "boolean" },
};

/** The identity.json key behind each tuning flag, so the package's messages name the flag. */
const KEY_FLAGS: readonly (readonly [string, string])[] = [
  ["tabs.max", "--tabs-max"],
  ["tabs.popups", "--tabs-popups"],
  ["tabs.park", "--tabs-park"],
  ["tabs.close", "--tabs-close"],
  ["backgroundThrottling", "--background-throttling"],
  ["settle", "--settle"],
  ["block.trackers", "--block-trackers"],
  ["block.types", "--block-types"],
  ["block.patterns", "--block-patterns"],
  ["cache.maxSize", "--cache-max-size"],
];

const TABS_MAX_PROBLEM = "--tabs-max must be a whole number from 0 (no cap) to 100";

/**
 * A rejected identity.json with each problem of a tuning key told as its flag: the package
 * says `identity "school": settle must be ...`, the command line says `--settle must be ...`.
 * Other messages stay as the package wrote them.
 */
function flagMessage(message: string): string {
  const problems = message.replace(/^identity "[^"]*": /, "").split("; ");
  const told = problems.map((p) => {
    const hit = KEY_FLAGS.find(([key]) => p.startsWith(`${key} `));
    return hit ? `${hit[1]}${p.slice(hit[0].length)}` : undefined;
  });
  return told.every((t) => t !== undefined) ? told.join("; ") : message;
}

/** A true or false flag value; also on/off and yes/no. */
function booleanValue(flag: string, v: string): boolean {
  const word = v.toLowerCase();
  if (["true", "on", "yes"].includes(word)) return true;
  if (["false", "off", "no"].includes(word)) return false;
  return fail(`${flag} must be true or false (an empty value removes it)`);
}

const list = (v: string) =>
  v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * A group of identity.json (tabs, block, cache) after the flags: `parts` set or (with null)
 * remove its keys, the rest of `base` stays. Null when nothing is left, so the key goes.
 */
function mergeGroup<T extends object>(base: T | undefined, parts: Partial<Record<keyof T, unknown>>): T | null {
  const next: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(parts)) {
    if (v === undefined) continue;
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return Object.keys(next).length ? (next as T) : null;
}

export const SETTINGS_FLAG_NAMES = Object.keys(SETTINGS_FLAGS).map((f) => `--${f}`);

/** The identity.json change the flags ask for; `current` fills the parts of health not given. */
export function settingsPatch(p: Parsed, current?: IdentitySettings): SettingsPatch {
  const patch: SettingsPatch = {};
  const value = (name: string) => {
    const v = str(p, name);
    return v === undefined ? undefined : v.trim() === "" ? null : v.trim();
  };
  for (const key of ["timezone", "locale", "region"] as const) {
    const v = value(key);
    if (v !== undefined) patch[key] = v;
  }
  const langs = value("languages");
  if (langs !== undefined)
    patch.languages =
      langs === null
        ? null
        : langs
            .split(",")
            .map((l) => l.trim())
            .filter(Boolean);
  const url = value("health-url");
  const text = value("health-text");
  const selector = value("health-selector");
  if (bool(p, "no-health")) {
    if (url !== undefined || text !== undefined || selector !== undefined)
      fail("--no-health does not go with the other --health flags");
    patch.health = null;
  } else if (url !== undefined || text !== undefined || selector !== undefined) {
    const base = current?.health;
    const health: HealthCheck = { url: url ?? base?.url ?? "" };
    const t = text === undefined ? base?.text : (text ?? undefined);
    const s = selector === undefined ? base?.selector : (selector ?? undefined);
    if (t) health.text = t;
    if (s) health.selector = s;
    if (!health.url) fail("a health check needs --health-url (a page only a signed-in user sees)");
    if (!health.text && !health.selector)
      fail("a health check needs --health-text or --health-selector (what that page shows when signed in)");
    patch.health = health;
  }
  tuningPatch(p, value, patch, current);
  return patch;
}

/** The format 2 keys of the patch: tabs, backgroundThrottling, settle, block and cache. */
function tuningPatch(
  p: Parsed,
  value: (name: string) => string | null | undefined,
  patch: SettingsPatch,
  current?: IdentitySettings,
): void {
  const tabs = {
    max: value("tabs-max"),
    popups: value("tabs-popups"),
    park: value("tabs-park"),
    close: value("tabs-close"),
  };
  if (bool(p, "no-tabs")) {
    if (Object.values(tabs).some((v) => v !== undefined)) fail("--no-tabs does not go with the other --tabs flags");
    patch.tabs = null;
  } else if (Object.values(tabs).some((v) => v !== undefined)) {
    let max: number | null | undefined;
    if (typeof tabs.max === "string") {
      if (!/^\d+$/.test(tabs.max)) fail(TABS_MAX_PROBLEM);
      max = Number(tabs.max);
    } else max = tabs.max;
    patch.tabs = mergeGroup<TabSettings>(current?.tabs, { ...tabs, max });
  }

  const throttling = value("background-throttling");
  if (throttling !== undefined)
    patch.backgroundThrottling = throttling === null ? null : booleanValue("--background-throttling", throttling);
  const settle = value("settle");
  if (settle !== undefined) patch.settle = settle;

  const trackers = value("block-trackers");
  const types = value("block-types");
  const patterns = value("block-patterns");
  if (bool(p, "no-block")) {
    if (trackers !== undefined || types !== undefined || patterns !== undefined)
      fail("--no-block does not go with the other --block flags");
    patch.block = null;
  } else if (trackers !== undefined || types !== undefined || patterns !== undefined) {
    patch.block = mergeGroup<BlockSettings>(current?.block, {
      trackers: typeof trackers === "string" ? booleanValue("--block-trackers", trackers) : trackers,
      types: typeof types === "string" ? list(types) : types,
      patterns: typeof patterns === "string" ? list(patterns) : patterns,
    });
  }

  const maxSize = value("cache-max-size");
  if (bool(p, "no-cache")) {
    if (bool(p, "cache") || maxSize !== undefined) fail("--no-cache does not go with --cache or --cache-max-size");
    patch.cache = null;
  } else if (bool(p, "cache") || maxSize !== undefined) {
    // The cache stays on when its size is removed: {} is on with the default size.
    patch.cache = mergeGroup<CacheSettings>(current?.cache, { maxSize }) ?? {};
  }
}

export function hasSettings(patch: SettingsPatch): boolean {
  return Object.keys(patch).length > 0;
}

function describeHealth(h: HealthCheck): string {
  return [h.url, h.text ? `shows "${h.text}"` : "", h.selector ? `has ${h.selector}` : ""].filter(Boolean).join(" ");
}

function describeTabs(t: TabSettings): string {
  const parts: string[] = [];
  if (t.max !== undefined) parts.push(t.max === 0 ? "no cap on open tabs" : `at most ${t.max} open`);
  if (t.popups) parts.push(t.popups === "keep" ? "popups kept" : "popups closed");
  if (t.park !== undefined) parts.push(t.park === "0" ? "never parked" : `parked after ${t.park}`);
  if (t.close !== undefined) parts.push(t.close === "0" ? "never closed when unused" : `closed after ${t.close}`);
  return parts.join(", ");
}

function describeBlock(b: BlockSettings): string {
  const n = b.patterns?.length ?? 0;
  return [b.trackers ? "trackers" : "", ...(b.types ?? []), n ? `${n} pattern${n === 1 ? "" : "s"}` : ""]
    .filter(Boolean)
    .join(", ");
}

export function show(m: BrowserApi, id: string, args: string[], io: Io): number {
  const p = parseFlags(args, JSON_FLAG, 1);
  if (!m.identityExists(id, io.env)) return fail(`identity "${id}" does not exist (turno identity add browser:${id})`);
  const { path, settings, problems } = m.checkIdentitySettings(id, io.env);
  const holder = m.inUseBy(id, io.env);
  const health = m.readHealth(id, io.env);
  if (bool(p, "json")) {
    emit(io, p, SHOW_JSON, {
      id: `browser:${id}`,
      dir: tildify(m.identityDir(id, io.env), io.env),
      settingsFile: tildify(path, io.env),
      settings: settings ?? null,
      problems,
      inUse: holder !== undefined,
      holder: holder ?? null,
      health: health ?? null,
    });
    return Exit.ok;
  }
  const s = style(io);
  const rows: [string, string][] = [
    ["profile", tildify(m.identityDir(id, io.env), io.env)],
    [
      "settings",
      `${tildify(path, io.env)}${settings || problems.length ? "" : s.muted(" (none: Chrome's own time zone and languages)")}`,
    ],
  ];
  if (settings) {
    rows.push(["time zone", settings.timezone ?? s.muted("(the system's)")]);
    if (settings.locale) rows.push(["locale", settings.locale]);
    rows.push([
      "languages",
      settings.languages?.join(", ") ?? s.muted(settings.locale ? "(from the locale)" : "(Chrome's)"),
    ]);
    if (settings.region) rows.push(["region", settings.region]);
    rows.push(["health check", settings.health ? describeHealth(settings.health) : s.muted("(none)")]);
    if (settings.tabs) rows.push(["tabs", `${describeTabs(settings.tabs)}${s.muted(" (the rest as default)")}`]);
    if (settings.backgroundThrottling !== undefined)
      rows.push([
        "throttling",
        settings.backgroundThrottling ? "background tabs throttled" : "every tab at full speed",
      ]);
    if (settings.settle !== undefined) rows.push(["settle", settings.settle]);
    if (settings.block) rows.push(["blocking", describeBlock(settings.block) || s.muted("(nothing)")]);
    if (settings.cache) rows.push(["cache", `on, up to ${settings.cache.maxSize ?? "100MB"}`]);
    if (settings.keychain === "system") rows.push(["cookie key", "the system keychain (identity.json keychain)"]);
    rows.push(["created", settings.created]);
    rows.push(["updated", settings.updated]);
  }
  if (health) {
    const state =
      health.status === "ok"
        ? s.ok("signed in")
        : health.status === "needs_auth"
          ? s.err("NEEDS_AUTH")
          : s.warn("check failed");
    rows.push(["last check", `${state} ${s.muted(`${health.checkedAt}${health.detail ? `: ${health.detail}` : ""}`)}`]);
  }
  rows.push([
    "state",
    holder ? s.warn(holder.replace(/^browser identity "[^"]+" is /, "").replace(/\. .*$/, "")) : s.ok("free"),
  ]);
  io.out(s.bold(`browser:${id}`));
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) io.out(s.kv(k, v, width));
  for (const problem of problems) io.out(s.note("err", `identity.json ${problem}`));
  if (health?.status === "needs_auth") io.out(s.note("info", `sign in again: turno browser login ${id}`));
  return Exit.ok;
}

const SET_FLAGS: FlagSpec = { ...SETTINGS_FLAGS, "dry-run": { type: "boolean" }, ...JSON_FLAG };

/** The arguments of `set` after the identity, for the usage line. */
export const SET_SYNOPSIS =
  "[--timezone <zone>] [--locale <tag>] [--languages <tag,...>] [--region <CC>] [--health-url <url>] [--health-text <text>] [--health-selector <css>] [--no-health] " +
  "[--tabs-max <n>] [--tabs-popups close|keep] [--tabs-park <duration>] [--tabs-close <duration>] [--no-tabs] [--background-throttling true|false] [--settle <duration>] " +
  "[--block-trackers true|false] [--block-types image,media,font] [--block-patterns <host|glob>,...] [--no-block] [--cache] [--cache-max-size <size>] [--no-cache] [--dry-run] [--json]";

/** More help for `set`: what each tuning flag writes to identity.json. */
export const SET_DETAILS = `Each flag writes one key of identity.json; an empty value (--settle "") removes it, and
--no-health, --no-tabs, --no-block and --no-cache remove a whole group. A flag of a group
changes only its part: the rest of that group stays.

How the host runs this identity's Chrome (read at every Chrome start):
  --tabs-max <n>                  most tabs open at once, 0 for no cap (default 8)
  --tabs-popups close|keep        close popups the agent did not open (default close)
  --tabs-park <duration>          park an unused tab on about:blank, "0" never (default 5m)
  --tabs-close <duration>         close an unused tab, "0" never (default 15m)
  --background-throttling <bool>  let Chrome slow tabs that are not in front (default false)
  --settle <duration>             wait after each action for the work it started, "0" to "10s"
  --block-trackers <bool>         block a built-in list of ad and analytics hosts
  --block-types <list>            block image, media and font requests (never the page itself)
  --block-patterns <list>         block host names (and subdomains) or URL globs with *
  --cache                         keep images, fonts, styles and scripts on disk (100MB)
  --cache-max-size <size>         the cache's size, "1MB" to "10GB"; turns the cache on

Blocking without the cache turns Chrome's own HTTP cache off: use them together.`;

/** The flags of `set`, for completion. */
export const SET_FLAG_NAMES = ["--dry-run", "--json", ...SETTINGS_FLAG_NAMES];

/**
 * The package's own validation, run on a copy: identity.json is copied to a throwaway data
 * folder and the patch written there, so `--dry-run` refuses exactly what the write would and
 * shows the file it would leave, without touching the real one.
 */
function rehearse(m: BrowserApi, id: string, patch: SettingsPatch, env: NodeJS.ProcessEnv): IdentitySettings {
  const dir = mkdtempSync(join(env.TMPDIR || tmpdir(), "turno-identity-"));
  try {
    const copy = { ...env, TURNO_DATA_DIR: dir };
    const from = m.identitySettingsPath(id, env);
    const to = m.identitySettingsPath(id, copy);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    if (existsSync(from)) copyFileSync(from, to);
    return m.writeIdentitySettings(id, patch, copy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function set(m: BrowserApi, id: string, args: string[], io: Io): number {
  const p = parseFlags(args, SET_FLAGS, 1);
  if (!m.identityExists(id, io.env)) return fail(`identity "${id}" does not exist (turno identity add browser:${id})`);
  const patch = settingsPatch(p, m.checkIdentitySettings(id, io.env).settings);
  if (!hasSettings(patch))
    return fail(`nothing to set: pass ${SETTINGS_FLAG_NAMES.join(", ")} (an empty value removes one)`);
  const dryRun = bool(p, "dry-run");
  let settings: IdentitySettings;
  try {
    settings = dryRun ? rehearse(m, id, patch, io.env) : m.writeIdentitySettings(id, patch, io.env);
  } catch (err) {
    if ((err as Error).name === "IdentityError") return fail(flagMessage((err as Error).message));
    throw err;
  }
  if (bool(p, "json")) {
    emit(io, p, SET_JSON, {
      id: `browser:${id}`,
      settingsFile: tildify(m.identitySettingsPath(id, io.env), io.env),
      dryRun,
      changes: patch,
      settings,
    });
    return Exit.ok;
  }
  if (dryRun) {
    io.out(`(dry run) would update identity.json of "${id}": ${JSON.stringify(patch)}`);
    return Exit.ok;
  }
  io.out(`updated identity.json of "${id}"; the next Chrome start of browser-${id} uses it\n`);
  return show(m, id, [], io);
}

const DOCTOR_FLAGS: FlagSpec = { fix: { type: "boolean" }, "no-launch": { type: "boolean" }, ...JSON_FLAG };

const SECTIONS: [string, (area: string) => boolean][] = [
  ["Chrome", (a) => a === "chrome"],
  ["System", (a) => a === "system"],
  ["Identities", (a) => a === "identities" || a.startsWith("identity ")],
];

export async function doctor(m: BrowserApi, args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, DOCTOR_FLAGS, 0);
  const json = bool(p, "json");
  const report = await m.runDoctor({ env: io.env, fix: bool(p, "fix"), launch: !bool(p, "no-launch") });
  const failed = report.checks.some((c) => c.level === "fail");
  const exit = failed ? Exit.failure : Exit.ok;
  const status = (c: DoctorCheck) => (c.level === "info" ? "skip" : c.level);
  const n = (l: DoctorCheck["level"]) => report.checks.filter((c) => c.level === l).length;
  if (json) {
    emit(io, p, DOCTOR_JSON, {
      ok: !failed,
      counts: { ok: n("ok"), warn: n("warn"), fail: n("fail"), skip: n("info") },
      fixed: report.fixed,
      checks: report.checks.map((c) => ({
        area: c.area,
        status: status(c),
        text: c.text,
        fix: c.level === "ok" ? null : (c.fix ?? null),
        auto: Boolean(c.auto) && (c.level === "warn" || c.level === "fail"),
        manual: c.level === "ok" ? null : (c.manual ?? null),
      })),
    });
    return exit;
  }
  const s = style(io);
  for (const f of report.fixed) io.out(s.check("ok", `fixed: ${f}`));
  if (report.fixed.length) io.out("");
  const ICON = { ok: "ok", warn: "warn", fail: "err", info: "skip" } as const;
  let first = true;
  for (const [title, has] of SECTIONS) {
    const rows = report.checks.filter((c) => has(c.area));
    if (!rows.length) continue;
    if (!first) io.out("");
    first = false;
    io.out(s.header(title));
    let area = "";
    for (const c of rows) {
      if (c.area.startsWith("identity ") && c.area !== area)
        io.out(`  ${s.bold(`browser:${c.area.slice("identity ".length)}`)}`);
      area = c.area;
      const indent = c.area.startsWith("identity ") ? 4 : 2;
      const text = c.level === "fail" ? s.err(c.text) : c.level === "info" ? s.muted(c.text) : c.text;
      io.out(s.note(ICON[c.level], text, indent));
      if (c.level === "ok") continue;
      const under = " ".repeat(indent + 2);
      const label = c.level === "info" ? "optional:" : "fix:";
      if (c.fix)
        io.out(
          s.wrap(
            `${under}${s.muted(label)} `,
            `${c.level === "info" ? s.muted(c.fix) : s.bold(c.fix)}${c.auto ? s.muted(" (runs with --fix)") : ""}`,
          ),
        );
      else if (c.manual) io.out(s.wrap(`${under}${s.muted("manual:")} `, c.manual));
    }
  }
  io.out("");
  io.out(
    [
      `${n("ok")} ok`,
      n("warn") ? `${n("warn")} warning${n("warn") === 1 ? "" : "s"}` : "",
      n("fail") ? `${n("fail")} failure${n("fail") === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(", "),
  );
  return exit;
}

export function reputation(m: BrowserApi, args: string[], io: Io, checkId: (id: string) => string): number {
  const p = parseFlags(args, JSON_FLAG, 1);
  const id = p.positionals[0] === undefined ? undefined : checkId(p.positionals[0].replace(/^browser:/, ""));
  let report: ReturnType<typeof m.reputationReport>;
  try {
    report = m.reputationReport(io.env, id ? [id] : undefined);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (bool(p, "json")) {
    emit(
      io,
      p,
      REPUTATION_JSON,
      report.identities.map((i) => ({
        id: `browser:${i.id}`,
        file: tildify(i.file, io.env),
        total: i.total,
        sites: i.sites,
      })),
    );
    return Exit.ok;
  }
  const s = style(io);
  if (!report.identities.length) {
    io.out("No browser identities yet. Create one with `turno identity add browser:<id>`.");
    return Exit.ok;
  }
  const TREND = { up: s.warn("up"), down: s.ok("down"), flat: s.muted("flat") };
  for (const [i, ident] of report.identities.entries()) {
    if (i) io.out("");
    io.out(s.header(`browser:${ident.id}`));
    if (!ident.sites.length) {
      io.out(`  ${s.muted("no challenges recorded")}`);
      continue;
    }
    const head = ["site", "total", "captcha", "verify", "block", "7d", "prev 7d", "trend", "last seen"].map((h) =>
      s.muted(h),
    );
    const rows = ident.sites.map((x) => [
      x.site,
      String(x.total),
      String(x.captcha),
      String(x.verify),
      String(x.block),
      String(x.last7d),
      String(x.prev7d),
      TREND[x.trend],
      x.lastSeen,
    ]);
    const right = { align: "right" as const };
    for (const l of s.table([head, ...rows], {
      columns: [{}, right, right, right, right, right, right, {}, { drop: 1 }],
    }))
      io.out(l);
  }
  return Exit.ok;
}

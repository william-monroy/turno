import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { browserPaths as paths } from "turno-core/paths";
import { IdentityError, assertIdentityId } from "./ids.js";
import { parseDuration, parseSize } from "./units.js";

/**
 * identity.json: what stays fixed for one browser identity, so a site sees the same person in
 * the same place every time. It sits next to the Chrome profile directory
 * (`<data>/browser/identities/<id>.json`), never inside it, so Chrome never reads or rewrites it
 * and copying a profile does not copy it by accident.
 *
 * - `timezone`: an IANA zone. Chrome gets it as `timezoneId`, only when it differs from the
 *   system's (an identity set up at home keeps that zone on a trip).
 * - `languages`: the Accept-Language order, passed as Chrome's own `--accept-lang`, so the
 *   header keeps Chrome's q-values and `navigator.languages` matches it. Without it, `locale`
 *   gives `[locale, base language]`.
 * - `locale`: also passed as `--lang` (Chrome's UI and, on Linux and Windows, `Intl`). It is not
 *   Playwright's `locale` option: that one collapses Accept-Language to a single value, which no
 *   installed Chrome sends (measured with Chrome 157).
 * - `region`: the two-letter country the identity's sites know it from. Recorded, not applied.
 * - `health`: a URL and a text or selector that proves the identity is signed in (session
 *   health, `health.ts`).
 * - `tabs`, `backgroundThrottling`, `settle`, `block`, `cache` (format 2): how the host runs this
 *   identity's Chrome
 *   (`tuning.ts`): the tab governor and background tab throttling.
 * - `keychain` (format 3): where Chrome gets the key that encrypts the profile's cookies.
 *   `"mock"` (the default, also when the key is missing) keeps Playwright's
 *   `--use-mock-keychain` and `--password-store=basic`, a fixed public key; `"system"` drops
 *   them, so Chrome uses the macOS Keychain or the Linux Secret Service.
 *
 * A missing file means Chrome's own defaults, as before identity.json existed.
 */

/**
 * The newest format version of identity.json this package reads, in its `version` key: turno's
 * state-file convention, where a file without `version` is format 1 and a newer one
 * is refused. Format 2 adds the browser keys (`FORMAT_2_KEYS`); a file is written as format 2
 * only when it uses one of them, so an older turno-browser keeps reading every other file and
 * refuses one it would misread with "update turno-browser".
 */
export const IDENTITY_FORMAT_VERSION = 3;

/** The keys format 2 added. */
const FORMAT_2_KEYS = ["tabs", "backgroundThrottling", "settle", "block", "cache"] as const;

/** The keys format 3 added. */
const FORMAT_3_KEYS = ["keychain"] as const;

/** Where Chrome gets its cookie encryption key. */
type KeychainMode = "mock" | "system";

/** Playwright's switches that give Chrome a fixed key instead of the OS store's. */
const MOCK_KEYCHAIN_SWITCHES = ["--use-mock-keychain", "--password-store=basic"] as const;

/** Resource types `block.types` may name: the heavy ones a page usually works without. */
const BLOCKABLE_TYPES = ["image", "media", "font"] as const;
type BlockableType = (typeof BLOCKABLE_TYPES)[number];

/** Opt-in resource blocking (`resources.ts`). */
interface BlockSettings {
  /** The built-in list of ad and tracker hosts. */
  trackers?: boolean;
  types?: BlockableType[];
  /** Host names (with their subdomains) or URL globs (`*` matches anything). */
  patterns?: string[];
}

/** Opt-in on-disk resource cache (`resources.ts`). */
interface CacheSettings {
  /** Size cap, like `"100MB"` (default 100MB). */
  maxSize?: string;
}

/** Largest cache accepted. */
const MAX_CACHE_BYTES = 10 * 1024 ** 3;

/** Longest `settle` accepted: past this, a wait is a `browser_wait_for`, not a settle. */
const MAX_SETTLE_MS = 10_000;

/** The tab governor (`tuning.ts`): durations are strings like `"5m"`, `"0"` turns a stage off. */
interface TabSettings {
  /** Most pages open at once; the least recently used one closes past it. 0: no cap. */
  max?: number;
  /** `"close"`: close a popup the agent did not open; `"keep"`: leave it. */
  popups?: "close" | "keep";
  /** Unused this long, a page is parked on about:blank (its URL comes back on the next use). */
  park?: string;
  /** Unused this long, a page is closed. */
  close?: string;
}

export interface HealthCheck {
  /** A page that shows `text` or `selector` only to a signed-in user. */
  url: string;
  text?: string;
  selector?: string;
}

export interface IdentitySettings {
  /** Format version (`IDENTITY_FORMAT_VERSION`); a file without it is format 1. */
  version?: number;
  timezone?: string;
  locale?: string;
  languages?: string[];
  region?: string;
  health?: HealthCheck;
  tabs?: TabSettings;
  /** True: let Chrome throttle tabs that are not in front (see `tuning.ts`). */
  backgroundThrottling?: boolean;
  /** Wait after each action for the work it started, like `"250ms"` (Playwright's `timeouts.settle`). */
  settle?: string;
  block?: BlockSettings;
  cache?: CacheSettings;
  /** `"system"`: Chrome encrypts cookies with the OS store's key; default `"mock"`. */
  keychain?: KeychainMode;
  /** ISO dates. */
  created: string;
  updated: string;
}

/** A change to identity.json: a value sets the key, `null` removes it. */
export type SettingsPatch = {
  [K in
    | "timezone"
    | "locale"
    | "languages"
    | "region"
    | "health"
    | (typeof FORMAT_2_KEYS)[number]
    | (typeof FORMAT_3_KEYS)[number]]?: IdentitySettings[K] | null;
};

const KEYS = new Set([
  "version",
  "timezone",
  "locale",
  "languages",
  "region",
  "health",
  ...FORMAT_2_KEYS,
  ...FORMAT_3_KEYS,
  "created",
  "updated",
]);

/**
 * The Chrome switches to drop for this identity's keychain setting, as Playwright launch
 * options: nothing for the default mock keychain.
 */
export function keychainArgs(settings: Pick<IdentitySettings, "keychain"> | undefined): {
  ignoreDefaultArgs?: string[];
} {
  return settings?.keychain === "system" ? { ignoreDefaultArgs: [...MOCK_KEYCHAIN_SWITCHES] } : {};
}

/**
 * The environment for a Chrome this process launches for an identity: the caller's, so HOME
 * and the XDG folders follow the identity's environment instead of this process's.
 */
export function chromeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function unknownKeys(v: Record<string, unknown>, allowed: string[], prefix: string, out: string[]): void {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) out.push(`unknown key "${prefix}.${k}"`);
}

/** Problems with the format 2 keys, in key order. */
function browserProblems(v: Record<string, unknown>, out: string[]): void {
  if (v.tabs !== undefined) {
    const t = v.tabs;
    if (!isObject(t)) out.push("tabs must be an object with max, popups, park or close");
    else {
      if (t.max !== undefined && (typeof t.max !== "number" || !Number.isInteger(t.max) || t.max < 0 || t.max > 100))
        out.push("tabs.max must be a whole number from 0 (no cap) to 100");
      if (t.popups !== undefined && t.popups !== "close" && t.popups !== "keep")
        out.push('tabs.popups must be "close" or "keep"');
      for (const k of ["park", "close"] as const) {
        if (t[k] !== undefined && (typeof t[k] !== "string" || parseDuration(t[k] as string) === undefined))
          out.push(`tabs.${k} must be a duration like "5m" or "0" (off)`);
      }
      unknownKeys(t, ["max", "popups", "park", "close"], "tabs", out);
    }
  }
  if (v.backgroundThrottling !== undefined && typeof v.backgroundThrottling !== "boolean")
    out.push("backgroundThrottling must be true or false");
  if (v.settle !== undefined) {
    const ms = typeof v.settle === "string" ? parseDuration(v.settle) : undefined;
    if (ms === undefined || ms > MAX_SETTLE_MS) out.push('settle must be a duration from "0" to "10s", like "250ms"');
  }
  if (v.block !== undefined) {
    const b = v.block;
    if (!isObject(b)) out.push("block must be an object with trackers, types or patterns");
    else {
      if (b.trackers !== undefined && typeof b.trackers !== "boolean") out.push("block.trackers must be true or false");
      if (
        b.types !== undefined &&
        (!Array.isArray(b.types) || b.types.some((t) => !(BLOCKABLE_TYPES as readonly unknown[]).includes(t)))
      ) {
        out.push(`block.types must be a list of ${BLOCKABLE_TYPES.map((t) => `"${t}"`).join(", ")}`);
      }
      if (
        b.patterns !== undefined &&
        (!Array.isArray(b.patterns) ||
          b.patterns.length > 500 ||
          b.patterns.some((p) => typeof p !== "string" || !p.trim() || /\s/.test(p)))
      ) {
        out.push("block.patterns must be a list of host names or URL patterns without spaces (at most 500)");
      }
      unknownKeys(b, ["trackers", "types", "patterns"], "block", out);
    }
  }
  if (v.keychain !== undefined && v.keychain !== "mock" && v.keychain !== "system")
    out.push('keychain must be "mock" (the default) or "system"');
  if (v.cache !== undefined) {
    const c = v.cache;
    if (!isObject(c)) out.push('cache must be an object, like {} or { "maxSize": "100MB" }');
    else {
      if (c.maxSize !== undefined) {
        const bytes = typeof c.maxSize === "string" ? parseSize(c.maxSize) : undefined;
        if (bytes === undefined || bytes < 1024 ** 2 || bytes > MAX_CACHE_BYTES)
          out.push('cache.maxSize must be a size from "1MB" to "10GB", like "100MB"');
      }
      unknownKeys(c, ["maxSize"], "cache", out);
    }
  }
}

export function identitySettingsPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  assertIdentityId(id);
  return join(paths(env).identitiesDir, `${id}.json`);
}

/** The system's IANA time zone, as Chrome reports it when nothing overrides it. */
export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The canonical form of a BCP 47 tag ("es-mx" is "es-MX"), or undefined when it is not one. */
function canonicalLocale(tag: string): string | undefined {
  try {
    const [c] = Intl.getCanonicalLocales(tag);
    return c;
  } catch {
    return undefined;
  }
}

const isoDate = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v);

/** Everything wrong with a parsed identity.json, in key order; empty when it is valid. */
function problemsOf(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["must be a JSON object"];
  const v = raw as Record<string, unknown>;
  const out: string[] = [];
  if (v.version !== undefined && (typeof v.version !== "number" || !Number.isInteger(v.version) || v.version < 1))
    out.push("version must be a positive integer");
  else if (typeof v.version === "number" && v.version > IDENTITY_FORMAT_VERSION) {
    return [
      `is format ${v.version}, from a newer turno-browser (this one reads up to ${IDENTITY_FORMAT_VERSION}); update turno-browser`,
    ];
  }
  if (v.timezone !== undefined) {
    if (typeof v.timezone !== "string") out.push("timezone must be a string");
    else if (!validTimezone(v.timezone))
      out.push(`timezone "${v.timezone}" is not an IANA time zone (for example "Europe/Madrid")`);
  }
  if (v.locale !== undefined) {
    if (typeof v.locale !== "string" || !canonicalLocale(v.locale))
      out.push(`locale "${String(v.locale)}" is not a language tag (for example "es-MX")`);
  }
  if (v.languages !== undefined) {
    if (!Array.isArray(v.languages) || v.languages.some((l) => typeof l !== "string" || !canonicalLocale(l)))
      out.push("languages must be a list of language tags");
    else if (v.languages.length === 0) out.push("languages needs at least one language tag");
  }
  if (v.region !== undefined && (typeof v.region !== "string" || !/^[A-Z]{2}$/.test(v.region))) {
    out.push(`region "${String(v.region)}" must be a two-letter country code (for example "MX")`);
  }
  if (v.health !== undefined) {
    const h = v.health as Record<string, unknown> | null;
    if (typeof h !== "object" || h === null || Array.isArray(h))
      out.push("health must be an object with url and text or selector");
    else {
      if (typeof h.url !== "string" || !/^https?:\/\//.test(h.url))
        out.push("health.url must start with http:// or https://");
      for (const k of ["text", "selector"] as const)
        if (h[k] !== undefined && (typeof h[k] !== "string" || !h[k]))
          out.push(`health.${k} must be a non-empty string`);
      if (h.text === undefined && h.selector === undefined)
        out.push("health needs text or selector (what only a signed-in page shows)");
      for (const k of Object.keys(h))
        if (!["url", "text", "selector"].includes(k)) out.push(`unknown key "health.${k}"`);
    }
  }
  browserProblems(v, out);
  if (!isoDate(v.created)) out.push("created must be an ISO date");
  if (!isoDate(v.updated)) out.push("updated must be an ISO date");
  for (const k of Object.keys(v)) if (!KEYS.has(k)) out.push(`unknown key "${k}"`);
  return out;
}

export interface SettingsCheck {
  path: string;
  /** Present when the file exists and is valid. */
  settings?: IdentitySettings;
  /** Why the file cannot be used; empty when it is valid or missing. */
  problems: string[];
}

/** Reads identity.json without throwing: for `turno browser doctor`. */
export function checkIdentitySettings(id: string, env: NodeJS.ProcessEnv = process.env): SettingsCheck {
  const path = identitySettingsPath(id, env);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { path, problems: [] };
    return { path, problems: [`cannot be read: ${(err as Error).message}`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { path, problems: ["is not valid JSON"] };
  }
  const problems = problemsOf(raw);
  return problems.length ? { path, problems } : { path, settings: raw as IdentitySettings, problems };
}

/** identity.json of the identity, undefined when there is none. Throws when it is invalid. */
export function readIdentitySettings(id: string, env: NodeJS.ProcessEnv = process.env): IdentitySettings | undefined {
  const { path, settings, problems } = checkIdentitySettings(id, env);
  if (problems.length)
    throw new IdentityError(
      `identity.json of "${id}" (${path}) ${problems[0]!.startsWith("is ") ? problems[0] : `is invalid: ${problems.join("; ")}`}`,
    );
  return settings;
}

/**
 * Applies a patch and writes the file (mode 600, through a rename so a reader never sees half
 * a file). Validates first: a bad value throws and leaves the file as it was.
 */
export function writeIdentitySettings(
  id: string,
  patch: SettingsPatch,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): IdentitySettings {
  const path = identitySettingsPath(id, env);
  const current = existsSync(path) ? readIdentitySettings(id, env) : undefined;
  const stamp = now.toISOString();
  const next: Record<string, unknown> = { ...current, created: current?.created ?? stamp, updated: stamp };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  next.version = FORMAT_3_KEYS.some((k) => next[k] !== undefined)
    ? 3
    : FORMAT_2_KEYS.some((k) => next[k] !== undefined)
      ? 2
      : 1;
  if (typeof next.locale === "string") next.locale = canonicalLocale(next.locale) ?? next.locale;
  if (Array.isArray(next.languages)) next.languages = (next.languages as string[]).map((l) => canonicalLocale(l) ?? l);
  if (typeof next.region === "string" && /^[a-z]{2}$/i.test(next.region)) next.region = next.region.toUpperCase();
  const problems = problemsOf(next);
  if (problems.length) throw new IdentityError(`identity "${id}": ${problems.join("; ")}`);
  // Stable key order, whatever order the patch came in.
  const ordered = Object.fromEntries(
    [...KEYS].filter((k) => next[k] !== undefined).map((k) => [k, next[k]]),
  ) as unknown as IdentitySettings;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ordered, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return ordered;
}

/** The Accept-Language order: `languages`, else the locale and its base language. */
export function acceptLanguages(settings: IdentitySettings): string[] | undefined {
  if (settings.languages?.length) return settings.languages;
  if (!settings.locale) return undefined;
  const base = settings.locale.split("-")[0]!;
  return base === settings.locale ? [settings.locale] : [settings.locale, base];
}

export interface LaunchSettings {
  /** Chrome flags to add. */
  args: string[];
  /** Playwright's `timezoneId`, when the identity's zone is not the system's. */
  timezoneId?: string;
}

const hasArg = (args: readonly string[], flag: string) => args.some((a) => a === flag || a.startsWith(`${flag}=`));

/**
 * What the chrome engine adds at launch for these settings. Flags and context options the user
 * already set (through `--config` or the Playwright MCP flags) always win.
 */
export function launchSettings(
  settings: IdentitySettings | undefined,
  userArgs: readonly string[],
  systemTz: string,
  userContext: Record<string, unknown> = {},
): LaunchSettings {
  const out: LaunchSettings = { args: [] };
  if (!settings) return out;
  if (settings.locale && !hasArg(userArgs, "--lang")) out.args.push(`--lang=${settings.locale}`);
  const languages = acceptLanguages(settings);
  if (languages && !hasArg(userArgs, "--accept-lang") && userContext.locale === undefined)
    out.args.push(`--accept-lang=${languages.join(",")}`);
  if (settings.timezone && settings.timezone !== systemTz && userContext.timezoneId === undefined)
    out.timezoneId = settings.timezone;
  return out;
}

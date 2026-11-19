import type { HumanizeLevel, HumanizeSettings } from "./humanize.js";
import { DEFAULT_CACHE_BYTES, type ResourcePolicy } from "./resources.js";
import type { IdentitySettings } from "./settings.js";
import type { SharingMode } from "./sharing.js";
import type { TabLockPolicy } from "./tab-locks.js";
import { parseDuration, parseSize } from "./units.js";

/**
 * How the host runs one session's Chrome: the tab governor, background tab
 * throttling, the wait after each action, and resource blocking and caching. Each value comes from, in order of precedence, a `turno-browser-mcp` flag, the
 * identity's identity.json, then the defaults below. identity.json is read at every launch,
 * like the rest of it.
 */

export interface TabPolicy {
  /** Most pages open at once; past it the least recently used page closes. 0: no cap. */
  max: number;
  /** Close a popup the agent did not open (`"close"`), or leave it (`"keep"`). */
  popups: "close" | "keep";
  /** A page unused this long is parked on about:blank; 0: never. */
  parkMs: number;
  /** A page unused this long is closed; 0: never. */
  closeMs: number;
}

export interface Tuning {
  tabs: TabPolicy;
  /**
   * False (the default): Chrome runs every tab at full speed, as Playwright launches it. True:
   * Chrome throttles the tabs that are not in front, and the host brings the agent's tab to the
   * front before each call (see `launchTuning`).
   */
  backgroundThrottling: boolean;
  /**
   * The wait after each action for the work it started (Playwright's `timeouts.settle`), from
   * identity.json `settle`; undefined keeps Playwright's (500 ms, or the user's own setting).
   */
  settleMs?: number;
  /** Opt-in resource blocking and cache, from identity.json `block` and `cache`. */
  resources: ResourcePolicy;
  /** Human-like input (`humanize.ts`), from `--humanize` or identity.json `humanize`; off by default. */
  humanize: HumanizeSettings;
  /**
   * `"session"` (the default): one backend serves every call, as mcpd's `exclusive = true` lets
   * one session at a time. `"tabs"`: each agent session gets its own tabs, with locks (`sharing.ts`).
   */
  sharing: SharingMode;
  /** With `"sharing": "tabs"`: the lock wait and idle release of identity.json `tabLocks`. */
  tabLocks: Partial<TabLockPolicy>;
}

/** The defaults, documented on the browser identities page. */
export const DEFAULT_TABS: Readonly<TabPolicy> = Object.freeze({
  max: 8,
  popups: "close",
  parkMs: 5 * 60_000,
  closeMs: 15 * 60_000,
});

/** What `turno-browser-mcp` flags set; each wins over identity.json. */
export interface TuningFlags {
  maxTabs?: number;
  popups?: "close" | "keep";
  parkAfterMs?: number;
  closeAfterMs?: number;
  backgroundThrottling?: boolean;
  humanize?: HumanizeLevel;
  sharing?: SharingMode;
}

/** The tuning of a session: flags, then identity.json, then the defaults. */
export function resolveTuning(settings: IdentitySettings | undefined, flags: TuningFlags = {}): Tuning {
  const t = settings?.tabs;
  const ms = (v: string | undefined) => (v === undefined ? undefined : parseDuration(v));
  // No flag of turno's: Playwright's --timeout-settle is the flag, and it wins (configForSession).
  const settle = ms(settings?.settle);
  return {
    tabs: {
      max: flags.maxTabs ?? t?.max ?? DEFAULT_TABS.max,
      popups: flags.popups ?? t?.popups ?? DEFAULT_TABS.popups,
      parkMs: flags.parkAfterMs ?? ms(t?.park) ?? DEFAULT_TABS.parkMs,
      closeMs: flags.closeAfterMs ?? ms(t?.close) ?? DEFAULT_TABS.closeMs,
    },
    backgroundThrottling: flags.backgroundThrottling ?? settings?.backgroundThrottling ?? false,
    ...(settle === undefined ? {} : { settleMs: settle }),
    resources: resourcePolicy(settings),
    humanize: {
      ...settings?.humanize,
      level: flags.humanize ?? settings?.humanize?.level ?? "off",
    },
    sharing: flags.sharing ?? settings?.sharing ?? "session",
    tabLocks: {
      ...(settings?.tabLocks?.wait === undefined ? {} : { waitMs: ms(settings.tabLocks.wait)! }),
      ...(settings?.tabLocks?.release === undefined ? {} : { releaseMs: ms(settings.tabLocks.release)! }),
    },
  };
}

function resourcePolicy(settings: IdentitySettings | undefined): ResourcePolicy {
  const out: ResourcePolicy = {};
  const b = settings?.block;
  if (b) out.block = { trackers: b.trackers ?? false, types: b.types ?? [], patterns: b.patterns ?? [] };
  if (settings?.cache)
    out.cacheBytes = settings.cache.maxSize
      ? (parseSize(settings.cache.maxSize) ?? DEFAULT_CACHE_BYTES)
      : DEFAULT_CACHE_BYTES;
  return out;
}

/**
 * The three switches Playwright adds to every Chromium launch so that pages in the background
 * keep running at full speed (`chromiumSwitches`, pinned by the contract test).
 */
export const BACKGROUND_SWITCHES = [
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
] as const;

/**
 * Launch options for `backgroundThrottling`. Dropping the switches is not enough: Playwright
 * also turns on focus emulation for every page (`Emulation.setFocusEmulationEnabled`), which
 * makes a page in the background report itself visible and run at full speed. `focusControl`
 * turns that off, so Chrome sees which tab is really in front (measured with Chrome 157: a busy
 * background tab drops from about 200 timer ticks and 120 animation frames a second to 1 and 0).
 */
export function launchTuning(tuning: Tuning): { ignoreDefaultArgs: string[]; contextOptions: Record<string, unknown> } {
  if (!tuning.backgroundThrottling) return { ignoreDefaultArgs: [], contextOptions: {} };
  return { ignoreDefaultArgs: [...BACKGROUND_SWITCHES], contextOptions: { focusControl: true } };
}

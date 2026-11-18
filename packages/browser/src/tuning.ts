import type { IdentitySettings } from "./settings.js";
import { parseDuration } from "./units.js";

/**
 * How the host runs one session's Chrome (ADR 0048): the tab governor and background tab
 * throttling. Each value comes from, in order of precedence, a `turno-browser-mcp` flag, the
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
}

/** The defaults, documented in ADR 0048 and the browser identities page. */
export const DEFAULT_TABS: Readonly<TabPolicy> = Object.freeze({ max: 8, popups: "close", parkMs: 5 * 60_000, closeMs: 15 * 60_000 });

/** What `turno-browser-mcp` flags set; each wins over identity.json. */
export interface TuningFlags {
  maxTabs?: number;
  popups?: "close" | "keep";
  parkAfterMs?: number;
  closeAfterMs?: number;
  backgroundThrottling?: boolean;
}

/** The tuning of a session: flags, then identity.json, then the defaults. */
export function resolveTuning(settings: IdentitySettings | undefined, flags: TuningFlags = {}): Tuning {
  const t = settings?.tabs;
  const ms = (v: string | undefined) => (v === undefined ? undefined : parseDuration(v));
  return {
    tabs: {
      max: flags.maxTabs ?? t?.max ?? DEFAULT_TABS.max,
      popups: flags.popups ?? t?.popups ?? DEFAULT_TABS.popups,
      parkMs: flags.parkAfterMs ?? ms(t?.park) ?? DEFAULT_TABS.parkMs,
      closeMs: flags.closeAfterMs ?? ms(t?.close) ?? DEFAULT_TABS.closeMs,
    },
    backgroundThrottling: flags.backgroundThrottling ?? settings?.backgroundThrottling ?? false,
  };
}

/**
 * The three switches Playwright adds to every Chromium launch so that pages in the background
 * keep running at full speed (`chromiumSwitches`, pinned by the contract test).
 */
export const BACKGROUND_SWITCHES = ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"] as const;

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

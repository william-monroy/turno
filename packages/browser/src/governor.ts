import type { BrowserContext, Frame, Page } from "patchright-core";
import type { TabPolicy } from "./tuning.js";

/**
 * The tab governor (ADR 0048). Chrome keeps every page an agent or a site opened, and each one
 * keeps running scripts, timers and network until somebody closes it; after a long session that
 * is most of the browser's memory and CPU. Per session's browser context it:
 *
 * - caps the pages open at once (`max`): when a new page goes past it, the least recently used
 *   page closes, never the agent's current tab or the new page;
 * - closes a popup (a page with an opener) that opened while no tool call was running, nor in
 *   the moments after one: ads and pop-unders, not the window a click of the agent opened
 *   (`popups: "close"`);
 * - parks a page nobody used for `parkMs`: it goes to about:blank, which stops its scripts, and
 *   keeps its URL; the next call that uses that page (it is the current tab, or `browser_tabs`
 *   selects it) loads the URL again first. After `closeMs` unused the page closes.
 *
 * A page counts as used when it is the current tab at the end of a tool call, and when its main
 * frame navigates (a person using a headed window). The current tab is never parked or closed,
 * and neither is the last page.
 */

/** A popup that opens this long after a tool call ended still counts as the call's. */
export const POPUP_GRACE_MS = 2_000;

interface PageState {
  lastUsed: number;
  /** The URL the page showed when it was parked. */
  parkedUrl?: string;
  /** True while the governor itself navigates the page (park, restore). */
  moving?: boolean;
}

export interface GovernorOptions {
  /** The page the stock tools act on (upstream's current tab), if any. */
  current(): Page | undefined;
  /** The pages in upstream's tab order (the indexes `browser_tabs` uses). */
  tabs(): Page[];
  now?: () => number;
  /** Sweep for unused pages on a timer (the default); tests call `sweep()` themselves. */
  timer?: boolean;
}

/** A URL short enough for one line of a tool result. */
function shortUrl(url: string): string {
  return url.length > 100 ? `${url.slice(0, 97)}...` : url;
}

function minutes(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`;
  const m = Math.round(ms / 60_000);
  return m === 1 ? "1 minute" : `${m} minutes`;
}

export class TabGovernor {
  private readonly pages = new Map<Page, PageState>();
  private calls = 0;
  private lastCallEnd = Number.NEGATIVE_INFINITY;
  private notes: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private sweeping: Promise<void> | undefined;
  private readonly now: () => number;
  private readonly adopting = new Set<Promise<void>>();
  private readonly onPage = (page: Page) => {
    const done = this.adopt(page)
      .catch(() => {})
      .finally(() => this.adopting.delete(done));
    this.adopting.add(done);
  };

  constructor(
    private readonly context: BrowserContext,
    private readonly policy: TabPolicy,
    private readonly options: GovernorOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    for (const page of this.context.pages()) this.track(page);
    this.context.on("page", this.onPage);
    const stages = [this.policy.parkMs, this.policy.closeMs].filter((ms) => ms > 0);
    if (stages.length && this.options.timer !== false) {
      const every = Math.min(60_000, Math.max(1_000, Math.min(...stages) / 5));
      this.timer = setInterval(() => void this.sweep().catch(() => {}), every);
      this.timer.unref();
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.context.off("page", this.onPage);
  }

  /** Resolves once every page opened so far has been looked at (popup check, cap). */
  async settled(): Promise<void> {
    await Promise.all([...this.adopting]);
  }

  /** A tool call starts: nothing is swept and popups count as asked for until it ends. */
  beginCall(): void {
    this.calls++;
  }

  /** A tool call ended: its current tab was used now. */
  endCall(): void {
    this.calls = Math.max(0, this.calls - 1);
    this.lastCallEnd = this.now();
    const current = this.options.current();
    if (current && !current.isClosed()) this.track(current).lastUsed = this.now();
  }

  /** What the governor did since the last call, one line each, for the next tool result. */
  takeNotes(): string[] {
    const out = this.notes;
    this.notes = [];
    return out;
  }

  /** The URL a parked page will load again, or undefined when it is not parked. */
  parkedUrl(page: Page): string | undefined {
    return this.pages.get(page)?.parkedUrl;
  }

  /**
   * Before a stock tool runs: when the page it is about to use is parked, load its URL again.
   * That page is the tab `browser_tabs` is about to select, else the current tab.
   */
  async prepare(name: string, args: Record<string, unknown>): Promise<void> {
    if (name === "browser_tabs") {
      if (args.action !== "select" || typeof args.index !== "number") return;
      const page = this.options.tabs()[args.index];
      if (page) await this.restore(page);
      return;
    }
    const current = this.options.current();
    if (!current) return;
    if (name === "browser_navigate") {
      // The call replaces the page anyway.
      const state = this.pages.get(current);
      if (state) state.parkedUrl = undefined;
      return;
    }
    await this.restore(current);
  }

  /** Marks parked tabs in a tab list of a tool result (`- 2: [](about:blank)`). */
  annotateTabs(text: string): string {
    if (!text.includes("](about:blank)")) return text;
    const tabs = this.options.tabs();
    return text.replace(/^(- (\d+):.*\]\(about:blank\))$/gm, (line, _all, index: string) => {
      const page = tabs[Number(index)];
      const url = page ? this.parkedUrl(page) : undefined;
      return url ? `${line} (parked, was ${shortUrl(url)}: selecting it loads that page again)` : line;
    });
  }

  /** Parks and closes pages that went unused too long. Never while a tool call runs. */
  async sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.sweepOnce().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  private async sweepOnce(): Promise<void> {
    const { parkMs, closeMs } = this.policy;
    const current = this.options.current();
    for (const [page, state] of [...this.pages]) {
      if (this.calls > 0) return;
      if (page === current || page.isClosed() || state.moving) continue;
      const unused = this.now() - state.lastUsed;
      if (closeMs > 0 && unused >= closeMs && this.openPages().length > 1) {
        const url = state.parkedUrl ?? page.url();
        await page.close().catch(() => {});
        this.note(`closed a tab unused for ${minutes(unused)} (${shortUrl(url)})`);
        continue;
      }
      if (parkMs > 0 && unused >= parkMs && state.parkedUrl === undefined) await this.park(page, state, unused);
    }
  }

  private openPages(): Page[] {
    return [...this.pages.keys()].filter((p) => !p.isClosed());
  }

  private track(page: Page): PageState {
    let state = this.pages.get(page);
    if (state) return state;
    const created: PageState = { lastUsed: this.now() };
    state = created;
    this.pages.set(page, created);
    page.once("close", () => this.pages.delete(page));
    page.on("framenavigated", (frame: Frame) => {
      if (created.moving || frame !== page.mainFrame()) return;
      // Navigated by someone else (the agent through a stock tool, or a person): in use again.
      created.lastUsed = this.now();
      created.parkedUrl = undefined;
    });
    return created;
  }

  /** A page Chrome just opened. */
  private async adopt(page: Page): Promise<void> {
    this.track(page);
    const asked = this.calls > 0 || this.now() - this.lastCallEnd < POPUP_GRACE_MS;
    if (this.policy.popups === "close" && !asked) {
      const opener = await page.opener().catch(() => null);
      if (opener) {
        await page.close().catch(() => {});
        this.note(`closed a popup that ${shortUrl(opener.url())} opened while no tool call was running`);
        return;
      }
    }
    await this.enforceCap(page);
  }

  private async enforceCap(added: Page): Promise<void> {
    const { max } = this.policy;
    if (max <= 0) return;
    const open = this.openPages();
    const excess = open.length - max;
    if (excess <= 0) return;
    const current = this.options.current();
    const lastUsed = (p: Page) => this.pages.get(p)?.lastUsed ?? 0;
    const victims = open
      .filter((p) => p !== current && p !== added)
      .sort((a, b) => lastUsed(a) - lastUsed(b))
      .slice(0, excess);
    for (const page of victims) {
      const url = this.pages.get(page)?.parkedUrl ?? page.url();
      await page.close().catch(() => {});
      this.note(`closed the least recently used tab (${shortUrl(url)}): more than ${max} were open`);
    }
  }

  private async park(page: Page, state: PageState, unused: number): Promise<void> {
    const url = page.url();
    if (!url || url.startsWith("about:")) return;
    state.moving = true;
    try {
      await page.goto("about:blank", { timeout: 5_000 });
      state.parkedUrl = url;
      this.note(`parked a tab unused for ${minutes(unused)} on about:blank (${shortUrl(url)}); using it again loads that page`);
    } catch {
      /* the page would not leave (a slow unload): try again on the next sweep */
    } finally {
      state.moving = false;
    }
  }

  private async restore(page: Page): Promise<void> {
    const state = this.pages.get(page);
    const url = state?.parkedUrl;
    if (!state || url === undefined || page.isClosed()) return;
    state.moving = true;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      this.note(`loaded ${shortUrl(url)} again in a tab that was parked`);
    } catch (error) {
      this.note(`could not load ${shortUrl(url)} again in a parked tab: ${String((error as Error).message ?? error).split("\n")[0]}`);
    } finally {
      state.moving = false;
      state.parkedUrl = undefined;
      state.lastUsed = this.now();
    }
  }

  private note(text: string): void {
    this.notes.push(text);
    if (this.notes.length > 20) this.notes.splice(0, this.notes.length - 20);
  }
}

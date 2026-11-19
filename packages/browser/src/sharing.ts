import type { BrowserContext, Page } from "patchright-core";
import type { TabView } from "./governor.js";
import { DIRECT_SESSION, type TabLockPolicy, TabLockedError, TabLocks, sessionLabel } from "./tab-locks.js";
import {
  type BrowserBackendInstance,
  type McpConfig,
  type ToolResult,
  type UpstreamContext,
  backendContext,
} from "./upstream.js";

/**
 * `"sharing": "tabs"`: several agent sessions work in one identity's browser at once, each in
 * its own tabs. mcpd relays every session's calls over the one stdio connection of a shared,
 * non-exclusive server and tells them apart by `_meta["io.turno/session"]`.
 *
 * Why one upstream `BrowserBackend` per session: upstream keeps the current tab, the tab list,
 * the modal states and the snapshot refs in the backend's `Context`, and each tool reads the
 * current tab more than once while it runs (the action, then the snapshot of the result). One
 * backend for every session would mean either a single current tab, so two sessions' calls
 * would have to run one after the other, or a current tab swapped under a call in flight.
 * Several backends on one browser context work (verified with patchright-core 1.64.3 and a
 * real Chrome, `test/tab-sharing.test.ts`): each `Context` lists every page of the context,
 * keeps its own current tab, and two sessions' navigations run at the same time on their own
 * tabs; disposing one leaves the pages and the browser alone. What turno adds:
 *
 * - The first backend (the one that launched the browser) stays the root: it owns the browser's
 *   lifetime, the idle limit and upstream's routes and init scripts. The others get a config
 *   without `initScript`, `initPage` and the network origins, so a page is not set up once per
 *   session, and their disposal closes nothing.
 * - Upstream points a backend that has no current tab at whatever page opens next, and at a
 *   neighbour when its tab closes. Before every call turno points the session's backend at the
 *   session's own tab (the one it last worked on, else the one it last used, else a free current
 *   tab, else a new one), and locks it (`tab-locks.ts`).
 * - `browser_close` closes only the session's tabs: the browser stays for the others.
 */

export type SharingMode = "session" | "tabs";

/** One session's backend and the config copy it reads on every call. */
export interface SessionView {
  backend: BrowserBackendInstance;
  config: McpConfig;
}

export interface TabSharingOptions {
  context: BrowserContext;
  /** The backend that launched the browser: it serves calls without a session id. */
  root: SessionView;
  /** A new backend on the same browser context (config from `viewConfig`). */
  createView(): Promise<SessionView>;
  policy: TabLockPolicy;
  now?: () => number;
}

/**
 * The config of a session's backend: the root's, without what upstream installs on the browser
 * context for each backend (init scripts, the init page module, the allowed and blocked origin
 * routes). The root installed them already and keeps them for the life of the browser.
 */
export function viewConfig(config: McpConfig): McpConfig {
  const c = config as McpConfig & {
    browser: McpConfig["browser"] & { initScript?: unknown; initPage?: unknown };
    network?: Record<string, unknown>;
  };
  const { initScript: _script, initPage: _page, ...browser } = c.browser;
  const out: McpConfig & { network?: Record<string, unknown> } = {
    ...config,
    browser,
    timeouts: { ...config.timeouts },
    snapshot: { ...config.snapshot },
  };
  if (c.network) {
    const { allowedOrigins: _allowed, blockedOrigins: _blocked, ...network } = c.network;
    out.network = network;
  }
  return out;
}

function shortUrl(url: string): string {
  return url.length > 100 ? `${url.slice(0, 97)}...` : url;
}

export class TabSharing {
  readonly locks: TabLocks<Page>;
  private readonly views = new Map<string, Promise<SessionView>>();
  private readonly ready = new Map<string, SessionView>();
  /** The tab each session last worked on. */
  private readonly working = new Map<string, Page>();
  private readonly watched = new WeakSet<Page>();
  private disposed = false;

  constructor(private readonly options: TabSharingOptions) {
    this.locks = new TabLocks(options.policy, options.now);
    this.views.set(DIRECT_SESSION, Promise.resolve(options.root));
    this.ready.set(DIRECT_SESSION, options.root);
  }

  /** The backend of `session`, created on its first call (`DIRECT_SESSION`: the root). */
  view(session: string): Promise<SessionView> {
    if (this.disposed) return Promise.reject(new Error("the browser closed"));
    const existing = this.views.get(session);
    if (existing) return existing;
    const slot: { promise?: Promise<SessionView> } = {};
    const created = (async () => {
      const v = await this.options.createView();
      await backendContext(v.backend)?.ensureBrowserContext();
      // Dropped while it was being made (the session ended, the browser closed): not needed.
      if (this.views.get(session) === slot.promise) this.ready.set(session, v);
      else void v.backend.dispose().catch(() => {});
      return v;
    })();
    slot.promise = created;
    created.catch(() => {
      if (this.views.get(session) === created) this.views.delete(session);
    });
    this.views.set(session, created);
    return created;
  }

  /** The tabs as one session's backend sees them, for the tab governor. */
  tabView(view: SessionView): TabView {
    return {
      current: () => backendContext(view.backend)?.currentTab()?.page,
      tabs: () =>
        backendContext(view.backend)
          ?.tabs()
          .map((t) => t.page) ?? [],
    };
  }

  /** Who holds a page, for the tab governor's cap. */
  owner(page: Page): string | undefined {
    return this.locks.holder(page);
  }

  /** Every page a session works on now: the governor never parks or closes them. */
  protectedPages(): Page[] {
    const out = new Set<Page>();
    for (const [session, page] of this.working) if (this.locks.active(session) && !page.isClosed()) out.add(page);
    for (const view of this.ready.values()) {
      const page = backendContext(view.backend)?.currentTab()?.page;
      if (page && !page.isClosed()) out.add(page);
    }
    return [...out];
  }

  /** A page Chrome opened: a popup belongs to the session that holds its opener. */
  async adopt(page: Page): Promise<void> {
    const opener = await page.opener().catch(() => null);
    if (!opener) return;
    const holder = this.locks.holder(opener);
    if (holder !== undefined) this.claim(holder, page);
  }

  /**
   * Before a stock call of `session`: points its backend at its own tab and locks the tab the call
   * acts on. Returns the error for the call when another session holds that tab past the wait.
   */
  async before(
    session: string,
    name: string,
    args: Record<string, unknown>,
    view: SessionView,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const ctx = backendContext(view.backend);
    if (!ctx) return undefined;
    await ctx.ensureBrowserContext();
    this.prune(session);
    if (name === "browser_tabs") {
      const index = typeof args.index === "number" ? args.index : undefined;
      if ((args.action === "select" || args.action === "close") && index !== undefined) {
        const target = ctx.tabs()[index]?.page;
        // A missing index is upstream's error ("Tab 7 not found").
        return target ? await this.lock(session, ctx, target, signal) : undefined;
      }
      if (args.action === "new") return undefined;
    }
    const page = this.pick(session, ctx) ?? (await ctx.newTab()).page;
    this.select(ctx, page);
    return await this.lock(session, ctx, page, signal);
  }

  /** After a call of `session`: the tab its backend now points at is its own. */
  after(session: string, view: SessionView): void {
    const ctx = backendContext(view.backend);
    if (!ctx) return;
    const page = ctx.currentTab()?.page;
    if (page && !page.isClosed() && this.claim(session, page)) {
      this.working.set(session, page);
      return;
    }
    // Upstream moved the backend to another session's tab (its own tab closed): go back to one of
    // the session's own, or to none, so the next call opens one.
    const own = this.locks.pagesOf(session).find((p) => !p.isClosed());
    if (own) {
      this.select(ctx, own);
      this.working.set(session, own);
    } else {
      this.working.delete(session);
      if (page) ctx._setCurrentTab(undefined);
    }
  }

  /** `browser_close` of one session: closes its tabs and lets go of them; the browser stays. */
  async close(session: string): Promise<ToolResult> {
    const pages = this.locks.releaseSession(session).filter((p) => !p.isClosed());
    for (const page of pages) await page.close().catch(() => {});
    this.working.delete(session);
    await this.dropView(session);
    const n = pages.length;
    return {
      content: [
        {
          type: "text",
          text: `### Result\nClosed ${n} tab${n === 1 ? "" : "s"} of this session. The browser stays open for the other agent sessions that share it ("sharing": "tabs").`,
        },
      ],
    };
  }

  /** mcpd said the session ended: its tabs are free (they stay open; the tab governor parks and closes them). */
  async endSession(session: string): Promise<void> {
    this.locks.releaseSession(session);
    this.working.delete(session);
    await this.dropView(session);
  }

  /** Marks, in a tab list of a result, the tabs other sessions hold. */
  annotate(text: string, session: string, view: SessionView): string {
    if (!/^- \d+: /m.test(text)) return text;
    const ctx = backendContext(view.backend);
    if (!ctx) return text;
    const tabs = ctx.tabs();
    return text.replace(/^- (\d+): .*$/gm, (line, index: string) => {
      const page = tabs[Number(index)]?.page;
      const holder = page ? this.locks.holder(page) : undefined;
      return holder !== undefined && holder !== session ? `${line} (in use by ${sessionLabel(holder)})` : line;
    });
  }

  /** The browser closed: every session's backend goes (the root is the host's). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [session, view] of this.views) {
      if (session === DIRECT_SESSION) continue;
      void view.then((v) => v.backend.dispose()).catch(() => {});
    }
    this.views.clear();
    this.ready.clear();
    this.working.clear();
  }

  /** The tab `session` should act on, or undefined when it needs a new one. */
  private pick(session: string, ctx: UpstreamContext): Page | undefined {
    const usable = (p: Page | undefined): p is Page => {
      if (!p || p.isClosed()) return false;
      const holder = this.locks.holder(p);
      return holder === undefined || holder === session;
    };
    const working = this.working.get(session);
    if (usable(working)) return working;
    const own = this.locks.pagesOf(session).find((p) => !p.isClosed());
    if (own) return own;
    const current = ctx.currentTab()?.page;
    return usable(current) ? current : undefined;
  }

  /** Points the backend at `page` without bringing it to the front. */
  private select(ctx: UpstreamContext, page: Page): void {
    if (ctx.currentTab()?.page === page) return;
    const tab = ctx.tabs().find((t) => t.page === page);
    if (tab) ctx._setCurrentTab(tab);
  }

  private async lock(
    session: string,
    ctx: UpstreamContext,
    page: Page,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const index = ctx.tabs().findIndex((t) => t.page === page);
    const what = `tab ${index} (${shortUrl(page.url())})`;
    try {
      await this.locks.acquire(session, page, what, signal);
    } catch (error) {
      if (error instanceof TabLockedError) return error.message;
      throw error;
    }
    this.watch(page);
    return undefined;
  }

  private claim(session: string, page: Page): boolean {
    if (!this.locks.claim(session, page)) return false;
    this.watch(page);
    return true;
  }

  private watch(page: Page): void {
    if (this.watched.has(page)) return;
    this.watched.add(page);
    page.once("close", () => this.locks.release(page));
  }

  /** Backends of sessions that lapsed (no call for `releaseMs`) go; a new call makes a new one. */
  private prune(caller: string): void {
    for (const session of [...this.ready.keys()]) {
      if (session === DIRECT_SESSION || session === caller || this.locks.active(session)) continue;
      void this.dropView(session);
    }
  }

  private async dropView(session: string): Promise<void> {
    if (session === DIRECT_SESSION) return;
    const view = this.views.get(session);
    this.views.delete(session);
    this.ready.delete(session);
    if (view) await view.then((v) => v.backend.dispose()).catch(() => {});
  }
}

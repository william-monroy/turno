import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "patchright-core";
import { describe, expect, it } from "vitest";
import { type SessionView, TabSharing, viewConfig } from "../src/sharing.js";
import type { BrowserBackendInstance, McpConfig } from "../src/upstream.js";

/**
 * How `"sharing": "tabs"` points each session's backend at its own tab, with fake pages and
 * fake upstream contexts that behave like upstream's (every context lists every page; one with
 * no current tab takes the next page that opens). The real Chrome runs are in tab-sharing.test.ts.
 */

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";

class FakePage extends EventEmitter {
  closed = false;
  constructor(public address: string) {
    super();
  }
  url(): string {
    return this.address;
  }
  isClosed(): boolean {
    return this.closed;
  }
  async opener(): Promise<null> {
    return null;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.emit("close");
  }
}

/** The browser context: its pages, shared by every fake upstream context. */
class Browser {
  readonly pages: FakePage[] = [];
  readonly contexts: FakeContext[] = [];
  open(url: string): FakePage {
    const page = new FakePage(url);
    this.pages.push(page);
    for (const c of this.contexts) c.added(page);
    page.once("close", () => {
      this.pages.splice(this.pages.indexOf(page), 1);
      for (const c of this.contexts) c.removed(page);
    });
    return page;
  }
}

/** Upstream's `Context`, as far as turno uses it. */
class FakeContext {
  private list: { page: FakePage }[] = [];
  private current: { page: FakePage } | undefined;
  constructor(private readonly browser: Browser) {
    browser.contexts.push(this);
  }
  async ensureBrowserContext(): Promise<void> {
    if (this.list.length) return;
    for (const page of this.browser.pages) this.added(page);
  }
  tabs() {
    return this.list;
  }
  currentTab() {
    return this.current;
  }
  async newTab() {
    const page = this.browser.open("about:blank");
    this.current = this.list.find((t) => t.page === page);
    return this.current!;
  }
  _setCurrentTab(tab: { page: FakePage } | undefined): void {
    this.current = tab;
  }
  added(page: FakePage): void {
    const tab = { page };
    this.list.push(tab);
    this.current ??= tab;
  }
  removed(page: FakePage): void {
    const i = this.list.findIndex((t) => t.page === page);
    if (i === -1) return;
    const [tab] = this.list.splice(i, 1);
    if (this.current === tab) this.current = this.list[Math.min(i, this.list.length - 1)];
  }
}

function fakeView(browser: Browser): SessionView & { disposed: () => boolean; ctx: FakeContext } {
  const ctx = new FakeContext(browser);
  let disposed = false;
  const backend = {
    _context: ctx,
    dispose: async () => {
      disposed = true;
    },
  } as unknown as BrowserBackendInstance;
  return { backend, config: {} as McpConfig, disposed: () => disposed, ctx };
}

function setup(policy = { waitMs: 0, releaseMs: 60_000 }) {
  let t = 1_000_000;
  const browser = new Browser();
  browser.open("about:blank");
  const root = fakeView(browser);
  const views: ReturnType<typeof fakeView>[] = [];
  const sharing = new TabSharing({
    context: {} as BrowserContext,
    root,
    policy,
    now: () => t,
    createView: async () => {
      const v = fakeView(browser);
      views.push(v);
      return v;
    },
  });
  /** One call of `session`, the way the host runs it: begin, view, before, the tool, after, end. */
  const call = async (
    session: string,
    name: string,
    args: Record<string, unknown> = {},
    tool?: (ctx: FakeContext) => void | Promise<void>,
  ) => {
    sharing.locks.begin(session, name);
    const view = (await sharing.view(session)) as ReturnType<typeof fakeView>;
    try {
      const refused = await sharing.before(session, name, args, view);
      if (refused) return { refused, view };
      await tool?.(view.ctx);
      return { refused: undefined, view, current: view.ctx.currentTab()?.page };
    } finally {
      sharing.after(session, view);
      sharing.locks.end(session);
    }
  };
  return { browser, root, views, sharing, call, advance: (ms: number) => (t += ms) };
}

describe("tab sharing: each session's own tab", () => {
  it("gives the first session the free tab and the next one a new tab, never the first one's", async () => {
    const s = setup();
    const first = await s.call(A, "browser_navigate");
    expect(first.current).toBe(s.browser.pages[0]);
    // B's backend lists every page, and upstream made A's page its current tab.
    const second = await s.call(B, "browser_navigate");
    expect(second.current).not.toBe(first.current);
    expect(s.browser.pages).toHaveLength(2);
    expect(s.sharing.owner(first.current as unknown as Page)).toBe(A);
    expect(s.sharing.owner(second.current as unknown as Page)).toBe(B);
  });

  it("points a session back at its own tab when upstream moved it to another session's", async () => {
    const s = setup();
    const a1 = (await s.call(A, "browser_navigate")).current!;
    const b1 = (await s.call(B, "browser_navigate")).current!;
    const a2 = (await s.call(A, "browser_tabs", { action: "new" }, (ctx) => void ctx.newTab())).current!;
    expect(a2).not.toBe(a1);
    // A closes its current tab: upstream moves A's current tab to a neighbour, which may be B's.
    const after = await s.call(A, "browser_tabs", { action: "close" }, async (ctx) => {
      await ctx.currentTab()!.page.close();
    });
    expect(after.view.ctx.currentTab()?.page).toBe(a1);
    expect((await s.call(A, "browser_snapshot")).current).toBe(a1);
    expect((await s.call(B, "browser_snapshot")).current).toBe(b1);
  });

  it("refuses another session's tab by index, and never locks a new tab", async () => {
    const s = setup();
    await s.call(A, "browser_navigate");
    await s.call(B, "browser_navigate");
    const refused = await s.call(B, "browser_tabs", { action: "select", index: 0 });
    expect(refused.refused).toContain("tab 0 (about:blank) is in use by another agent session, session aaaaaaaa");
    const closing = await s.call(B, "browser_tabs", { action: "close", index: 0 });
    expect(closing.refused).toContain("is in use by another agent session");
    const fresh = await s.call(B, "browser_tabs", { action: "new" }, (ctx) => void ctx.newTab());
    expect(fresh.refused).toBeUndefined();
    expect(s.sharing.owner(fresh.current as unknown as Page)).toBe(B);
  });

  it("frees a session's tabs and drops its backend when it ends; a lapsed session's backend goes too", async () => {
    const s = setup();
    const a = (await s.call(A, "browser_navigate")).current!;
    await s.call(B, "browser_navigate");
    await s.sharing.endSession(A);
    expect(s.views[0]!.disposed()).toBe(true);
    expect(s.sharing.owner(a as unknown as Page)).toBeUndefined();
    expect((await s.call(B, "browser_tabs", { action: "select", index: 0 })).refused).toBeUndefined();
    // B goes quiet past releaseMs; A's next call prunes B's backend.
    s.advance(61_000);
    await s.call(A, "browser_navigate");
    expect(s.views[1]!.disposed()).toBe(true);
    expect(s.root.disposed()).toBe(false);
  });

  it("marks the tabs other sessions hold in a tab list", async () => {
    const s = setup();
    await s.call(A, "browser_navigate");
    const b = await s.call(B, "browser_navigate");
    const text = "### Result\n- 0: [](about:blank)\n- 1: (current) [](about:blank)";
    expect(s.sharing.annotate(text, B, b.view)).toBe(
      "### Result\n- 0: [](about:blank) (in use by session aaaaaaaa)\n- 1: (current) [](about:blank)",
    );
  });

  it("closes only the calling session's tabs on browser_close", async () => {
    const s = setup();
    await s.call(A, "browser_navigate");
    await s.call(A, "browser_tabs", { action: "new" }, (ctx) => void ctx.newTab());
    const b = (await s.call(B, "browser_navigate")).current!;
    const result = await s.sharing.close(A);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Closed 2 tabs of this session") });
    expect(s.browser.pages).toEqual([b]);
  });
});

describe("viewConfig", () => {
  it("leaves out what the root backend already installed on the browser context", () => {
    const config = {
      browser: { browserName: "chromium", launchOptions: {}, initScript: ["a.js"], initPage: ["p.js"] },
      network: { allowedOrigins: ["example.com"], blockedOrigins: ["ads.example"] },
      timeouts: { idle: 1 },
      snapshot: { mode: "full" },
      server: {},
    } as unknown as McpConfig;
    const view = viewConfig(config) as McpConfig & { network?: unknown; browser: Record<string, unknown> };
    expect(view.browser).not.toHaveProperty("initScript");
    expect(view.browser).not.toHaveProperty("initPage");
    expect(view.network).toEqual({});
    expect(view.snapshot).not.toBe(config.snapshot);
    expect(view.snapshot).toEqual({ mode: "full" });
  });
});

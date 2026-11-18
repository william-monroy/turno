import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "patchright-core";
import { describe, expect, it } from "vitest";
import { POPUP_GRACE_MS, TabGovernor } from "../src/governor.js";
import { DEFAULT_TABS, type TabPolicy } from "../src/tuning.js";

/**
 * The tab governor against fake pages and a fake clock: the cap, popups, the two parking
 * stages and the restore. The same behavior on a real Chrome is in browser-tools.test.ts.
 */

class FakePage extends EventEmitter {
  closed = false;
  readonly frame = {};
  gotos: string[] = [];
  constructor(
    public address: string,
    private readonly openerPage: FakePage | null = null,
  ) {
    super();
  }
  url(): string {
    return this.address;
  }
  isClosed(): boolean {
    return this.closed;
  }
  mainFrame(): unknown {
    return this.frame;
  }
  async opener(): Promise<FakePage | null> {
    return this.openerPage;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
  async goto(url: string): Promise<null> {
    this.gotos.push(url);
    this.address = url;
    this.emit("framenavigated", this.frame);
    return null;
  }
}

class FakeContext extends EventEmitter {
  readonly all: FakePage[] = [];
  pages(): FakePage[] {
    return this.all.filter((p) => !p.closed);
  }
  open(page: FakePage): FakePage {
    this.all.push(page);
    this.emit("page", page);
    return page;
  }
}

function setup(policy: Partial<TabPolicy> = {}, initial = ["https://a.example/"]) {
  let t = 1_000_000;
  const context = new FakeContext();
  for (const url of initial) context.all.push(new FakePage(url));
  let current: FakePage | undefined = context.all[0];
  const governor = new TabGovernor(context as unknown as BrowserContext, { ...DEFAULT_TABS, ...policy }, {
    current: () => current as unknown as Page | undefined,
    tabs: () => context.pages() as unknown as Page[],
    now: () => t,
    timer: false,
  });
  governor.start();
  return {
    context,
    governor,
    advance(ms: number) {
      t += ms;
    },
    select(page: FakePage) {
      current = page;
    },
    /** A tool call that leaves `page` as the current tab. */
    async call(page: FakePage | undefined = current, during?: () => void | Promise<void>) {
      governor.beginCall();
      if (page) current = page;
      await during?.();
      await governor.settled();
      governor.endCall();
    },
  };
}

describe("tab governor: cap", () => {
  it("closes the least recently used pages past the cap, never the current tab or the new page", async () => {
    const g = setup({ max: 3 });
    const [a] = g.context.all;
    const b = new FakePage("https://b.example/");
    const c = new FakePage("https://c.example/");
    await g.call(a, () => void g.context.open(b));
    g.advance(1000);
    await g.call(a, () => void g.context.open(c));
    g.advance(1000);
    await g.call(b);
    g.advance(1000);
    // a is current again; c is the least recently used one now.
    const d = new FakePage("https://d.example/");
    await g.call(a!, () => void g.context.open(d));
    expect(g.context.pages().map((p) => p.url())).toEqual(["https://a.example/", "https://b.example/", "https://d.example/"]);
    expect(g.governor.takeNotes()).toEqual(["closed the least recently used tab (https://c.example/): more than 3 were open"]);
  });

  it("does nothing with max 0", async () => {
    const g = setup({ max: 0 });
    await g.call(undefined, () => {
      for (let i = 0; i < 12; i++) g.context.open(new FakePage(`https://${i}.example/`));
    });
    expect(g.context.pages()).toHaveLength(13);
  });
});

describe("tab governor: popups", () => {
  it("closes a popup that opens while no tool call runs, and keeps one a call opened", async () => {
    const g = setup();
    const [a] = g.context.all;
    const asked = new FakePage("https://login.example/", a!);
    await g.call(a, () => void g.context.open(asked));
    expect(asked.closed).toBe(false);

    g.advance(POPUP_GRACE_MS + 1);
    const ad = g.context.open(new FakePage("https://ads.example/", a!));
    await g.governor.settled();
    expect(ad.closed).toBe(true);
    expect(g.governor.takeNotes()).toEqual(["closed a popup that https://a.example/ opened while no tool call was running"]);
  });

  it("keeps a popup that opens just after a call ended, and a page without an opener", async () => {
    const g = setup();
    const [a] = g.context.all;
    await g.call(a);
    g.advance(POPUP_GRACE_MS - 500);
    const late = g.context.open(new FakePage("https://late.example/", a!));
    g.advance(10_000);
    const byHand = g.context.open(new FakePage("https://typed.example/"));
    await g.governor.settled();
    expect(late.closed).toBe(false);
    expect(byHand.closed).toBe(false);
  });

  it("keeps every popup with popups: keep", async () => {
    const g = setup({ popups: "keep" });
    const ad = g.context.open(new FakePage("https://ads.example/", g.context.all[0]!));
    await g.governor.settled();
    expect(ad.closed).toBe(false);
  });
});

describe("tab governor: parking", () => {
  it("parks a page unused for parkMs on about:blank, then closes it after closeMs; never the current tab", async () => {
    const g = setup({ parkMs: 5 * 60_000, closeMs: 15 * 60_000 });
    const [a] = g.context.all;
    const b = new FakePage("https://b.example/inbox");
    await g.call(a, () => void g.context.open(b));
    g.advance(4 * 60_000);
    await g.governor.sweep();
    expect(b.gotos).toEqual([]);

    g.advance(60_000);
    await g.governor.sweep();
    expect(b.url()).toBe("about:blank");
    expect(g.governor.parkedUrl(b as unknown as Page)).toBe("https://b.example/inbox");
    expect(a!.gotos).toEqual([]);
    expect(g.governor.takeNotes()).toEqual(["parked a tab unused for 5 minutes on about:blank (https://b.example/inbox); using it again loads that page"]);

    g.advance(10 * 60_000);
    await g.governor.sweep();
    expect(b.closed).toBe(true);
    expect(a!.closed).toBe(false);
    expect(g.governor.takeNotes()).toEqual(["closed a tab unused for 15 minutes (https://b.example/inbox)"]);
  });

  it("does not sweep while a tool call runs, and never closes the last page", async () => {
    const g = setup({ parkMs: 60_000, closeMs: 120_000 });
    const [a] = g.context.all;
    const b = g.context.open(new FakePage("https://b.example/"));
    g.select(b);
    g.advance(10 * 60_000);
    g.governor.beginCall();
    await g.governor.sweep();
    expect(a!.gotos).toEqual([]);
    g.governor.endCall();
    await b.close();
    g.select(a!);
    await g.governor.sweep();
    expect(a!.closed).toBe(false);
  });

  it("loads a parked page again before the call that selects it, and marks parked tabs in a tab list", async () => {
    const g = setup({ parkMs: 60_000, closeMs: 0 });
    const [a] = g.context.all;
    const b = new FakePage("https://b.example/inbox");
    await g.call(a, () => void g.context.open(b));
    g.advance(2 * 60_000);
    await g.governor.sweep();
    g.governor.takeNotes();
    expect(g.governor.annotateTabs("- 0: (current) [A](https://a.example/)\n- 1: [](about:blank)")).toBe(
      "- 0: (current) [A](https://a.example/)\n- 1: [](about:blank) (parked, was https://b.example/inbox: selecting it loads that page again)",
    );

    await g.governor.prepare("browser_tabs", { action: "select", index: 1 });
    expect(b.gotos).toEqual(["about:blank", "https://b.example/inbox"]);
    expect(g.governor.parkedUrl(b as unknown as Page)).toBeUndefined();
    expect(g.governor.takeNotes()).toEqual(["loaded https://b.example/inbox again in a tab that was parked"]);
  });

  it("loads the current tab again when it is parked (its neighbor closed), but not before browser_navigate", async () => {
    const g = setup({ parkMs: 60_000, closeMs: 0 });
    const [a] = g.context.all;
    const b = new FakePage("https://b.example/");
    await g.call(a, () => void g.context.open(b));
    g.advance(2 * 60_000);
    await g.governor.sweep();
    g.select(b);
    await g.governor.prepare("browser_navigate", { url: "https://c.example/" });
    expect(b.gotos).toEqual(["about:blank"]);
    expect(g.governor.parkedUrl(b as unknown as Page)).toBeUndefined();

    // The navigate itself, then the tab sits unused again and is parked again.
    await g.call(b, () => b.goto("https://b.example/").then(() => {}));
    g.select(a!);
    g.advance(2 * 60_000);
    await g.governor.sweep();
    g.select(b);
    await g.governor.prepare("browser_snapshot", {});
    expect(b.gotos.at(-1)).toBe("https://b.example/");
  });

  it("counts a navigation of the page as a use (a person in a headed window)", async () => {
    const g = setup({ parkMs: 60_000, closeMs: 0 });
    const b = g.context.open(new FakePage("https://b.example/"));
    await g.governor.settled();
    g.advance(50_000);
    await b.goto("https://b.example/next");
    g.advance(50_000);
    await g.governor.sweep();
    expect(b.url()).toBe("https://b.example/next");
  });
});

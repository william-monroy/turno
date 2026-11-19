import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "patchright-core";
import { describe, expect, it } from "vitest";
import { POPUP_GRACE_MS, TabGovernor } from "../src/governor.js";
import { DEFAULT_TABS } from "../src/tuning.js";

/**
 * The tab governor in attach mode (`ownedOnly`): in the user's own Chrome it governs only the
 * agent's tabs. Fake pages and a fake clock, like governor.test.ts.
 */

class FakePage extends EventEmitter {
  closed = false;
  readonly frame = {};
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

function setup(max = 2) {
  let t = 1_000_000;
  const context = new FakeContext();
  const userTabs = [new FakePage("https://mail.example/"), new FakePage("https://bank.example/")];
  context.all.push(...userTabs);
  let current: FakePage | undefined;
  const owned: Page[] = [];
  const governor = new TabGovernor(
    context as unknown as BrowserContext,
    { ...DEFAULT_TABS, max, parkMs: 60_000, closeMs: 120_000 },
    {
      current: () => current as unknown as Page | undefined,
      tabs: () => context.pages() as unknown as Page[],
      now: () => t,
      timer: false,
      ownedOnly: true,
      onOwn: (page) => owned.push(page),
    },
  );
  governor.start();
  const agentTab = new FakePage("about:blank");
  context.all.push(agentTab);
  governor.own(agentTab as unknown as Page);
  current = agentTab;
  return {
    context,
    governor,
    userTabs,
    agentTab,
    owned,
    advance(ms: number) {
      t += ms;
    },
    select(page: FakePage) {
      current = page;
    },
    async call(during?: () => void | Promise<void>) {
      governor.beginCall();
      await during?.();
      await governor.afterCall();
      governor.endCall();
    },
  };
}

describe("tab governor in attach mode", () => {
  it("never parks or closes the user's tabs, however long they sit unused", async () => {
    const s = setup();
    s.advance(10 * 60_000);
    await s.governor.sweep();
    expect(s.userTabs.map((p) => p.closed)).toEqual([false, false]);
    expect(s.userTabs.map((p) => p.url())).toEqual(["https://mail.example/", "https://bank.example/"]);
  });

  it("counts only the agent's tabs for the cap and closes the oldest of those", async () => {
    const s = setup(2);
    const opened: FakePage[] = [];
    await s.call(() => {
      opened.push(s.context.open(new FakePage("https://a.example/")));
    });
    s.advance(1000);
    await s.call(() => {
      opened.push(s.context.open(new FakePage("https://b.example/")));
    });
    await s.governor.settled();
    // Three agent tabs (the first plus two), cap 2: the least recently used agent tab closes.
    expect(s.userTabs.some((p) => p.closed)).toBe(false);
    expect([s.agentTab, ...opened].filter((p) => p.closed)).toHaveLength(1);
    expect(s.owned).toHaveLength(3);
  });

  it("leaves a tab the user opens between calls alone, popup or not", async () => {
    const s = setup(1);
    s.advance(POPUP_GRACE_MS + 1);
    const popup = s.context.open(new FakePage("https://ad.example/", s.userTabs[0]!));
    const tab = s.context.open(new FakePage("https://news.example/"));
    await s.governor.settled();
    expect(popup.closed).toBe(false);
    expect(tab.closed).toBe(false);
    expect(s.owned).toEqual([s.agentTab]);
  });

  it("keeps a user's tab the agent selected as the user's", async () => {
    const s = setup();
    s.select(s.userTabs[0]!);
    await s.call();
    s.advance(10 * 60_000);
    s.select(s.agentTab);
    await s.governor.sweep();
    expect(s.userTabs[0]!.closed).toBe(false);
    expect(s.userTabs[0]!.url()).toBe("https://mail.example/");
  });
});

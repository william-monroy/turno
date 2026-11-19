import { describe, expect, it } from "vitest";
import { DIRECT_SESSION, TabLockedError, TabLocks, sessionLabel } from "../src/tab-locks.js";

/**
 * The per-tab locks of `"sharing": "tabs"`, with plain objects for pages and a clock the test
 * moves. The real browser runs are in tab-sharing.test.ts.
 */

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("tab locks", () => {
  it("gives a free tab to the first session and refuses it to another while the holder is active", () => {
    const c = clock();
    const locks = new TabLocks<object>({ waitMs: 0, releaseMs: 60_000 }, c.now);
    const tab = {};
    locks.begin(A, "browser_navigate");
    expect(locks.claim(A, tab)).toBe(true);
    locks.end(A);
    expect(locks.holder(tab)).toBe(A);
    expect(locks.claim(A, tab)).toBe(true);
    expect(locks.claim(B, tab)).toBe(false);
    expect(locks.pagesOf(A)).toEqual([tab]);
    expect(locks.pagesOf(B)).toEqual([]);
  });

  it("lets go of a session's tabs after releaseMs without a call, never while a call runs", () => {
    const c = clock();
    const locks = new TabLocks<object>({ waitMs: 0, releaseMs: 60_000 }, c.now);
    const tab = {};
    locks.begin(A, "browser_click");
    locks.claim(A, tab);
    c.advance(10 * 60_000);
    // Still in its call: held however long it takes.
    expect(locks.holder(tab)).toBe(A);
    locks.end(A);
    c.advance(59_000);
    expect(locks.holder(tab)).toBe(A);
    c.advance(1_000);
    expect(locks.holder(tab)).toBeUndefined();
    expect(locks.claim(B, tab)).toBe(true);
    expect(locks.pagesOf(A)).toEqual([]);
  });

  it("frees a tab when it closes and every tab of a session when it ends", () => {
    const locks = new TabLocks<object>({ waitMs: 0, releaseMs: 60_000 });
    const [one, two, three] = [{}, {}, {}];
    locks.begin(A, "browser_tabs");
    locks.claim(A, one);
    locks.claim(A, two);
    locks.end(A);
    locks.begin(B, "browser_tabs");
    locks.claim(B, three);
    locks.end(B);
    locks.release(one);
    expect(locks.holder(one)).toBeUndefined();
    expect(locks.releaseSession(A)).toEqual([two]);
    expect(locks.holder(two)).toBeUndefined();
    expect(locks.holder(three)).toBe(B);
  });

  it("lists a session's tabs most recently used first", () => {
    const c = clock();
    const locks = new TabLocks<object>({ waitMs: 0, releaseMs: 60_000 }, c.now);
    const [one, two] = [{}, {}];
    locks.begin(A, "x");
    locks.claim(A, one);
    c.advance(10);
    locks.claim(A, two);
    c.advance(10);
    expect(locks.pagesOf(A)).toEqual([two, one]);
    locks.claim(A, one);
    expect(locks.pagesOf(A)).toEqual([one, two]);
  });

  it("makes another session's call wait for the tab and take it once the holder lets go", async () => {
    const locks = new TabLocks<object>({ waitMs: 5_000, releaseMs: 0 });
    const tab = {};
    locks.begin(A, "browser_navigate");
    locks.claim(A, tab);
    locks.begin(B, "browser_click");
    const waiting = locks.acquire(B, tab, "tab 0 (https://example.com/)");
    let done = false;
    void waiting.then(() => (done = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    // releaseMs 0: the tab is free as soon as the holder's call ends.
    locks.end(A);
    await waiting;
    expect(locks.holder(tab)).toBe(B);
  });

  it("fails after waitMs with a message that names the holder, the tab and the way out", async () => {
    const locks = new TabLocks<object>({ waitMs: 50, releaseMs: 5 * 60_000 });
    const tab = {};
    locks.begin(A, "browser_type");
    locks.claim(A, tab);
    locks.end(A);
    const start = Date.now();
    const error = await locks.acquire(B, tab, "tab 1 (https://mail.example.com/)").catch((e: unknown) => e);
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
    expect(error).toBeInstanceOf(TabLockedError);
    const message = (error as Error).message;
    expect(message).toContain("tab 1 (https://mail.example.com/) is in use by another agent session");
    expect(message).toContain("session aaaaaaaa (last call browser_type 0 s ago)");
    expect(message).toContain("waited 0.1 seconds");
    expect(message).toContain("after 300 seconds without a call");
    expect(message).toContain('browser_tabs with action "new"');
    expect(locks.holder(tab)).toBe(A);
  });

  it("says a holder is running a call, and stops waiting when the call is cancelled", async () => {
    const locks = new TabLocks<object>({ waitMs: 60_000, releaseMs: 60_000 });
    const tab = {};
    locks.begin(A, "browser_wait_for");
    locks.claim(A, tab);
    const abort = new AbortController();
    const waiting = locks.acquire(B, tab, "tab 0 (about:blank)", abort.signal).catch((e: unknown) => e);
    setTimeout(() => abort.abort(), 20);
    const error = (await waiting) as Error;
    expect(error).toBeInstanceOf(TabLockedError);
    expect(error.message).toContain("(running browser_wait_for)");
  });

  it("names a client connected without mcpd plainly", () => {
    expect(sessionLabel(DIRECT_SESSION)).toBe("the client connected without mcpd");
    expect(sessionLabel(A)).toBe("session aaaaaaaa");
  });
});

/**
 * Per-tab locks for an identity whose browser several agent sessions share (`"sharing": "tabs"`).
 *
 * A session holds every tab it works on: the tab its calls act on, the tabs it opened or selected,
 * and the popups those tabs opened. Another session's call on a held tab waits up to `waitMs` for
 * it and then fails with a message that names the holder. A session lets go of its tabs when
 * mcpd says it ended, when a tab closes, and when it makes no call for `releaseMs` (a session that
 * died without a word frees its tabs on its own). A call in flight always keeps its session's
 * tabs, however long it runs.
 *
 * Generic over the page type so the rules are tested without a browser.
 */

export interface TabLockPolicy {
  /** How long a call waits for a tab another session holds before it fails. */
  waitMs: number;
  /** A session that makes no call for this long holds nothing; 0: tabs are free between calls. */
  releaseMs: number;
}

/** The defaults, documented on the browser identities page. */
export const DEFAULT_TAB_LOCKS: Readonly<TabLockPolicy> = Object.freeze({ waitMs: 10_000, releaseMs: 5 * 60_000 });

/** The lock key of calls that came without a session id (a client connected without mcpd). */
export const DIRECT_SESSION = "";

interface SessionState {
  lastSeen: number;
  /** Calls of this session in flight. */
  calls: number;
  lastTool?: string;
}

interface Hold {
  session: string;
  /** When the holder last used the tab: its most recently used tab is where it goes back to. */
  lastUsed: number;
}

/** A call refused because another session holds the tab. */
export class TabLockedError extends Error {
  override name = "TabLockedError";
}

/** A short, readable name for a session in a message: the start of mcpd's opaque id. */
export function sessionLabel(session: string): string {
  return session === DIRECT_SESSION ? "the client connected without mcpd" : `session ${session.slice(0, 8)}`;
}

function ago(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} s ago`;
  return `${Math.round(ms / 60_000)} min ago`;
}

function seconds(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  return s === 1 ? "1 second" : `${s} seconds`;
}

export class TabLocks<P extends object> {
  private readonly holds = new Map<P, Hold>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly waiters = new Set<() => void>();
  private readonly now: () => number;

  constructor(
    readonly policy: TabLockPolicy,
    now: () => number = Date.now,
  ) {
    this.now = now;
  }

  /** A call of `session` starts: until it ends, the session keeps every tab it holds. */
  begin(session: string, tool: string): void {
    const s = this.state(session);
    s.calls++;
    s.lastTool = tool;
    s.lastSeen = this.now();
  }

  /** A call of `session` ended. */
  end(session: string): void {
    const s = this.sessions.get(session);
    if (!s) return;
    s.calls = Math.max(0, s.calls - 1);
    s.lastSeen = this.now();
    this.wake();
  }

  /** Whether the session still holds its tabs: a call in flight, or one within `releaseMs`. */
  active(session: string): boolean {
    const s = this.sessions.get(session);
    if (!s) return false;
    return s.calls > 0 || this.now() - s.lastSeen < this.policy.releaseMs;
  }

  /** The session that holds `page`, or undefined when it is free. A lapsed session holds nothing. */
  holder(page: P): string | undefined {
    const hold = this.holds.get(page);
    if (!hold) return undefined;
    if (this.active(hold.session)) return hold.session;
    this.releaseSession(hold.session);
    return undefined;
  }

  /** Takes `page` for `session` when it is free or already its own; false when another holds it. */
  claim(session: string, page: P): boolean {
    const holder = this.holder(page);
    if (holder !== undefined && holder !== session) return false;
    this.state(session);
    this.holds.set(page, { session, lastUsed: this.now() });
    return true;
  }

  /**
   * Takes `page` for `session`, waiting up to `waitMs` while another session holds it. Throws a
   * `TabLockedError` whose message says which tab (`describe`), who holds it and what to do.
   */
  async acquire(session: string, page: P, describe: string, signal?: AbortSignal): Promise<void> {
    const deadline = this.now() + this.policy.waitMs;
    for (;;) {
      if (this.claim(session, page)) return;
      const holder = this.holder(page);
      if (holder === undefined) continue;
      const left = deadline - this.now();
      if (left <= 0 || signal?.aborted) throw new TabLockedError(this.lockedMessage(holder, describe));
      const st = this.sessions.get(holder);
      // Wake when the holder lapses, a lock is released or a call ends, or the wait is over.
      const lapse = st && st.calls === 0 ? st.lastSeen + this.policy.releaseMs - this.now() : left;
      await this.sleep(Math.max(1, Math.min(left, lapse)), signal);
    }
  }

  /** The tab closed: nobody holds it. */
  release(page: P): void {
    if (this.holds.delete(page)) this.wake();
  }

  /** Lets go of every tab of `session` and forgets it; returns the tabs it held. */
  releaseSession(session: string): P[] {
    const released: P[] = [];
    for (const [page, hold] of this.holds) {
      if (hold.session !== session) continue;
      this.holds.delete(page);
      released.push(page);
    }
    const s = this.sessions.get(session);
    if (s && s.calls === 0) this.sessions.delete(session);
    if (released.length) this.wake();
    return released;
  }

  /** The tabs `session` holds, most recently used first. */
  pagesOf(session: string): P[] {
    if (!this.active(session)) return [];
    return [...this.holds]
      .filter(([, h]) => h.session === session)
      .sort(([, a], [, b]) => b.lastUsed - a.lastUsed)
      .map(([page]) => page);
  }

  /** "session 3f2a9c1b (last call browser_click 12 s ago)". */
  describeHolder(session: string): string {
    const s = this.sessions.get(session);
    if (!s) return sessionLabel(session);
    const doing = s.calls > 0 ? `running ${s.lastTool}` : `last call ${s.lastTool} ${ago(this.now() - s.lastSeen)}`;
    return `${sessionLabel(session)} (${doing})`;
  }

  private lockedMessage(holder: string, describe: string): string {
    const release =
      this.policy.releaseMs > 0
        ? `it is released when that session ends or after ${seconds(this.policy.releaseMs)} without a call`
        : "it is released when that session's call ends";
    return (
      `${describe} is in use by another agent session, ${this.describeHolder(holder)}; ` +
      `waited ${seconds(this.policy.waitMs)} for it (${release}). ` +
      `Work in a tab of your own: browser_tabs with action "new" opens one, and action "list" shows which tabs are taken.`
    );
  }

  private state(session: string): SessionState {
    let s = this.sessions.get(session);
    if (!s) {
      s = { lastSeen: this.now(), calls: 0 };
      this.sessions.set(session, s);
    }
    return s;
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

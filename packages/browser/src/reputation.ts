import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChallengeKind, classifyChallenge } from "./detectors.js";
import { IdentityError, identityStateDir } from "./ids.js";
import { identityExists, listIdentities } from "./identities.js";

/**
 * The reputation log (ADR 0044): every challenge a page of an identity showed, one JSON line in
 * `<state>/browser/identities/<id>/reputation.jsonl`:
 *
 *     {"ts":"2026-11-17T16:00:00.000Z","site":"mail.example.com","kind":"verify","markers":["verify it's you"]}
 *
 * Only the host name and the matched phrases (from the fixed list in `detectors.ts`): no path,
 * no query, no page content. A site's reputation is not a score a test page gives; it is how
 * often the site stops the identity, and whether that goes up or down. `turno browser
 * reputation` shows the counts and the trend of the last 7 days against the 7 before.
 */

export interface ChallengeEvent {
  ts: string;
  site: string;
  kind: ChallengeKind;
  markers: string[];
}

export interface SiteSummary {
  site: string;
  total: number;
  captcha: number;
  verify: number;
  block: number;
  last7d: number;
  prev7d: number;
  trend: "up" | "down" | "flat";
  lastSeen: string;
}

export interface IdentityReputation {
  id: string;
  file: string;
  total: number;
  sites: SiteSummary[];
}

/** The log keeps about this many bytes; older lines go first. */
const MAX_BYTES = 1024 * 1024;
const DAY = 86_400_000;

export function reputationPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(identityStateDir(id, env), "reputation.jsonl");
}

export function recordChallenge(
  id: string,
  env: NodeJS.ProcessEnv,
  event: Omit<ChallengeEvent, "ts">,
  now: Date = new Date(),
): void {
  const file = reputationPath(id, env);
  mkdirSync(identityStateDir(id, env), { recursive: true, mode: 0o700 });
  const line: ChallengeEvent = { ts: now.toISOString(), site: event.site, kind: event.kind, markers: event.markers };
  appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  try {
    if (statSync(file).size > MAX_BYTES) {
      const lines = readFileSync(file, "utf8").trim().split("\n");
      writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`, { mode: 0o600 });
    }
  } catch {
    /* trimming is best effort */
  }
}

function isEvent(v: unknown): v is ChallengeEvent {
  const e = v as Partial<ChallengeEvent> | null;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof e.ts === "string" &&
    typeof e.site === "string" &&
    (e.kind === "captcha" || e.kind === "verify" || e.kind === "block") &&
    Array.isArray(e.markers)
  );
}

/** Every event of the identity's log, oldest first. Lines that do not parse are skipped. */
export function readChallenges(id: string, env: NodeJS.ProcessEnv = process.env): ChallengeEvent[] {
  let text: string;
  try {
    text = readFileSync(reputationPath(id, env), "utf8");
  } catch {
    return [];
  }
  const out: ChallengeEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (isEvent(v)) out.push(v);
    } catch {
      /* a torn or foreign line */
    }
  }
  return out;
}

/** Counts per site, most recent first, with the trend of the last 7 days against the 7 before. */
export function summarizeChallenges(events: readonly ChallengeEvent[], now: Date = new Date()): SiteSummary[] {
  const bySite = new Map<string, SiteSummary>();
  const t = now.getTime();
  for (const e of events) {
    const s = bySite.get(e.site) ?? {
      site: e.site,
      total: 0,
      captcha: 0,
      verify: 0,
      block: 0,
      last7d: 0,
      prev7d: 0,
      trend: "flat",
      lastSeen: e.ts,
    };
    s.total++;
    s[e.kind]++;
    const age = t - Date.parse(e.ts);
    if (age <= 7 * DAY) s.last7d++;
    else if (age <= 14 * DAY) s.prev7d++;
    if (e.ts > s.lastSeen) s.lastSeen = e.ts;
    bySite.set(e.site, s);
  }
  for (const s of bySite.values()) s.trend = s.last7d > s.prev7d ? "up" : s.last7d < s.prev7d ? "down" : "flat";
  return [...bySite.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || a.site.localeCompare(b.site));
}

/** The report of `turno browser reputation`: the identities asked for, or every one. */
export function reputationReport(
  env: NodeJS.ProcessEnv = process.env,
  ids?: readonly string[],
  now: Date = new Date(),
): { identities: IdentityReputation[] } {
  const list = ids?.length ? [...ids] : listIdentities(env).map((i) => i.id);
  for (const id of list) if (!identityExists(id, env)) throw new IdentityError(`identity "${id}" does not exist`);
  return {
    identities: list.map((id) => {
      const events = readChallenges(id, env);
      return { id, file: reputationPath(id, env), total: events.length, sites: summarizeChallenges(events, now) };
    }),
  };
}

interface WatchedPage {
  url(): string;
  content(): Promise<string>;
  on(event: "load", listener: () => void): unknown;
  off?(event: "load", listener: () => void): unknown;
}

interface WatchedContext {
  pages(): WatchedPage[];
  on(event: "page", listener: (page: WatchedPage) => void): unknown;
  off?(event: "page", listener: (page: WatchedPage) => void): unknown;
}

export interface WatchOptions {
  /** The same site and kind within this long counts once (a reload loop). */
  dedupeMs?: number;
  now?: () => number;
}

/**
 * Looks at every page the context loads (each main frame `load`, popups included) and reports
 * a challenge page: its host name, kind and matched phrases. Returns a function that stops.
 */
export function watchChallenges(
  context: WatchedContext,
  onChallenge: (event: Omit<ChallengeEvent, "ts">) => void,
  opts: WatchOptions = {},
): () => void {
  const dedupeMs = opts.dedupeMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const last = new Map<string, number>();
  const listeners = new Map<WatchedPage, () => void>();
  let stopped = false;
  const inspect = async (page: WatchedPage) => {
    let site: string;
    try {
      const url = new URL(page.url());
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      site = url.hostname;
    } catch {
      return;
    }
    const html = await page.content().catch(() => undefined);
    if (stopped || html === undefined) return;
    const found = classifyChallenge(html);
    if (!found) return;
    const key = `${site}\n${found.kind}`;
    const t = now();
    const previous = last.get(key);
    if (previous !== undefined && t - previous < dedupeMs) return;
    last.set(key, t);
    onChallenge({ site, kind: found.kind, markers: found.markers });
  };
  const attach = (page: WatchedPage) => {
    if (listeners.has(page)) return;
    const listener = () => void inspect(page).catch(() => {});
    listeners.set(page, listener);
    page.on("load", listener);
  };
  for (const p of context.pages()) attach(p);
  context.on("page", attach);
  return () => {
    stopped = true;
    context.off?.("page", attach);
    for (const [page, listener] of listeners) page.off?.("load", listener);
    listeners.clear();
  };
}

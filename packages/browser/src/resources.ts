import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Request, Route } from "patchright-core";

/**
 * Opt-in resource blocking and an opt-in on-disk resource cache, per identity. Both
 * are off by default; identity.json `block` and `cache` turn them on.
 *
 * One context route sees every request. Blocking aborts it (`blockedbyclient`), as an ad
 * blocker does. The cache serves a fresh copy of an image, font, stylesheet or script from disk
 * with `route.fulfill`, and otherwise lets the request go on in Chrome (`route.fallback`), so
 * Chrome's own network stack and its TLS fingerprint fetch it; the body is stored when the
 * request finishes. Nothing is fetched from Node.
 *
 * A route turns off Chrome's own HTTP cache for the context (Playwright does that whenever it
 * intercepts), which is why the cache is worth having next to blocking.
 */

/** Ad and tracker hosts the `trackers` switch blocks, with their subdomains. Kept short on purpose. */
const TRACKER_HOSTS: readonly string[] = Object.freeze([
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "google-analytics.com",
  "googletagmanager.com",
  "googletagservices.com",
  "adservice.google.com",
  "connect.facebook.net",
  "ads-twitter.com",
  "analytics.tiktok.com",
  "bat.bing.com",
  "clarity.ms",
  "hotjar.com",
  "scorecardresearch.com",
  "quantserve.com",
  "moatads.com",
  "adnxs.com",
  "adsrvr.org",
  "amazon-adsystem.com",
  "criteo.com",
  "criteo.net",
  "taboola.com",
  "outbrain.com",
  "pubmatic.com",
  "rubiconproject.com",
  "openx.net",
  "casalemedia.com",
  "mathtag.com",
]);

/** Resource types the cache keeps: the static ones. */
const CACHED_TYPES = new Set(["image", "font", "stylesheet", "script"]);

/** Response headers never replayed from the cache: the body is stored decoded, and no cookie. */
const DROPPED_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "age",
]);

export interface BlockPolicy {
  trackers: boolean;
  types: readonly string[];
  patterns: readonly string[];
}

export interface ResourcePolicy {
  block?: BlockPolicy;
  /** Size cap of the cache in bytes; undefined: no cache. */
  cacheBytes?: number;
}

/** Default cache size when identity.json has `"cache": {}`. */
export const DEFAULT_CACHE_BYTES = 100 * 1024 ** 2;

/** A host suffix (`ads.example`), or a URL glob where `*` matches anything (`*://cdn.example/ads/*`). */
type Matcher = (url: URL) => boolean;

function matcher(pattern: string): Matcher {
  const p = pattern.trim().toLowerCase();
  if (!p.includes("/") && !p.includes("*")) return (url) => url.hostname === p || url.hostname.endsWith(`.${p}`);
  const glob = p.includes("://") || p.startsWith("*") ? p : `*://${p}`;
  const re = new RegExp(
    `^${glob
      .split("*")
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return (url) => re.test(url.href.toLowerCase());
}

/**
 * The block check of a policy: why a request is blocked, or undefined. The page itself (a main
 * frame navigation) never is.
 */
export function blocker(
  policy: BlockPolicy,
): (url: URL, type: string, mainFrameNavigation: boolean) => string | undefined {
  const patterns = policy.patterns.map(matcher);
  const trackers = policy.trackers ? TRACKER_HOSTS.map((h) => matcher(h)) : [];
  return (url, type, mainFrameNavigation) => {
    if (mainFrameNavigation) return undefined;
    if (policy.types.includes(type)) return `type ${type}`;
    if (trackers.some((m) => m(url))) return "tracker";
    if (patterns.some((m) => m(url))) return "pattern";
    return undefined;
  };
}

/**
 * How long a response stays fresh, in ms, from its headers (RFC 9111, as a private cache);
 * undefined when it must not be stored or reused without asking the server.
 */
export function freshness(headers: Record<string, string>, now: number = Date.now()): number | undefined {
  const cc = (headers["cache-control"] ?? "").toLowerCase();
  const directives = new Map(
    cc
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [k, v] = d.split("=", 2);
        return [k!.trim(), v?.trim().replace(/^"|"$/g, "")] as const;
      }),
  );
  if (directives.has("no-store") || directives.has("no-cache")) return undefined;
  let lifetime: number | undefined;
  const maxAge = directives.get("max-age");
  if (maxAge !== undefined) {
    const n = Number(maxAge);
    if (Number.isFinite(n)) lifetime = n * 1000;
  } else if (headers.expires) {
    const expires = Date.parse(headers.expires);
    const date = headers.date ? Date.parse(headers.date) : now;
    if (Number.isFinite(expires) && Number.isFinite(date)) lifetime = expires - date;
  }
  if (lifetime === undefined) return undefined;
  const age = Number(headers.age ?? 0);
  if (Number.isFinite(age) && age > 0) lifetime -= age * 1000;
  return lifetime > 0 ? lifetime : undefined;
}

/**
 * Whether a finished response may go into the cache. Never one with Set-Cookie, never one asked
 * for with Authorization, and a Vary only on Accept-Encoding (the body is stored decoded) or
 * Origin (kept with the entry).
 */
export function storable(
  method: string,
  type: string,
  status: number,
  request: Record<string, string>,
  response: Record<string, string>,
): boolean {
  if (method !== "GET" || status !== 200 || !CACHED_TYPES.has(type)) return false;
  if (request.authorization !== undefined || response["set-cookie"] !== undefined) return false;
  const vary = (response.vary ?? "")
    .toLowerCase()
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return vary.every((v) => v === "accept-encoding" || v === "origin");
}

interface EntryMeta {
  url: string;
  status: number;
  headers: Record<string, string>;
  expiresAt: number;
  /** The request's Origin when the response varies on it. */
  origin?: string | null;
  size: number;
}

/**
 * The files of the cache: `<key>.json` (written last, so its presence means the entry is whole)
 * and `<key>.bin`, both mode 600 in a directory of mode 700, written to a temporary name and
 * renamed. Least recently used entries go first when the total passes the cap.
 */
export class ResourceCache {
  private readonly index = new Map<string, { size: number; used: number }>();
  private total = 0;

  constructor(
    private readonly dir: string,
    private readonly maxBytes: number,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const key = name.slice(0, -5);
      try {
        const meta = JSON.parse(readFileSync(join(dir, name), "utf8")) as EntryMeta;
        this.index.set(key, { size: meta.size, used: statSync(join(dir, name)).mtimeMs });
        this.total += meta.size;
      } catch {
        void this.remove(key);
      }
    }
  }

  /** Largest single entry: a tenth of the cache, and never more than 20 MB. */
  get maxEntry(): number {
    return Math.min(20 * 1024 ** 2, Math.floor(this.maxBytes / 10));
  }

  get size(): number {
    return this.total;
  }

  static key(url: string): string {
    return createHash("sha256").update(url).digest("hex");
  }

  /** A fresh entry for this URL and Origin, or undefined. */
  async get(url: string, origin: string | undefined): Promise<{ meta: EntryMeta; body: Buffer } | undefined> {
    const key = ResourceCache.key(url);
    if (!this.index.has(key)) return undefined;
    try {
      const meta = JSON.parse(await readFile(join(this.dir, `${key}.json`), "utf8")) as EntryMeta;
      if (meta.url !== url) return undefined;
      if (meta.expiresAt <= this.now()) {
        await this.remove(key);
        return undefined;
      }
      if (meta.origin !== undefined && meta.origin !== (origin ?? null)) return undefined;
      const body = await readFile(join(this.dir, `${key}.bin`));
      const now = this.now();
      this.index.set(key, { size: meta.size, used: now });
      void utimes(join(this.dir, `${key}.json`), now / 1000, now / 1000).catch(() => {});
      return { meta, body };
    } catch {
      await this.remove(key);
      return undefined;
    }
  }

  /** Stores an entry; false when it is too large or could not be written. */
  async put(meta: EntryMeta, body: Buffer): Promise<boolean> {
    if (body.length > this.maxEntry) return false;
    const key = ResourceCache.key(meta.url);
    const tmp = `.${randomBytes(6).toString("hex")}.tmp`;
    const binTmp = join(this.dir, `${key}.bin${tmp}`);
    const jsonTmp = join(this.dir, `${key}.json${tmp}`);
    try {
      await this.remove(key);
      await writeFile(binTmp, body, { mode: 0o600 });
      await rename(binTmp, join(this.dir, `${key}.bin`));
      await writeFile(jsonTmp, JSON.stringify({ ...meta, size: body.length }), { mode: 0o600 });
      await rename(jsonTmp, join(this.dir, `${key}.json`));
    } catch {
      await rm(binTmp, { force: true }).catch(() => {});
      await rm(jsonTmp, { force: true }).catch(() => {});
      return false;
    }
    this.index.set(key, { size: body.length, used: this.now() });
    this.total += body.length;
    await this.evict();
    return true;
  }

  private async evict(): Promise<void> {
    if (this.total <= this.maxBytes) return;
    const oldest = [...this.index].sort((a, b) => a[1].used - b[1].used);
    for (const [key] of oldest) {
      if (this.total <= this.maxBytes) break;
      await this.remove(key);
    }
  }

  private async remove(key: string): Promise<void> {
    const entry = this.index.get(key);
    if (entry) {
      this.total -= entry.size;
      this.index.delete(key);
    }
    await rm(join(this.dir, `${key}.json`), { force: true }).catch(() => {});
    await rm(join(this.dir, `${key}.bin`), { force: true }).catch(() => {});
  }
}

function isMainFrameNavigation(request: Request): boolean {
  try {
    return request.isNavigationRequest() && request.frame().parentFrame() === null;
  } catch {
    return false;
  }
}

/** What the route did so far in this browser. */
export interface ResourceStats {
  blocked: number;
  hits: number;
  stored: number;
}

/**
 * Routes the context's requests through the policy. Does nothing (and leaves Chrome's HTTP cache
 * on) when the policy blocks nothing and has no cache, or the cache has no directory.
 */
export async function installResources(
  context: BrowserContext,
  policy: ResourcePolicy,
  cacheDir: string | undefined,
): Promise<ResourceStats | undefined> {
  const block = policy.block;
  const blocking = !!block && (block.trackers || block.types.length > 0 || block.patterns.length > 0);
  const cache =
    policy.cacheBytes !== undefined && cacheDir ? new ResourceCache(cacheDir, policy.cacheBytes) : undefined;
  if (!blocking && !cache) return undefined;
  const blocked = block ? blocker(block) : undefined;
  const stats: ResourceStats = { blocked: 0, hits: 0, stored: 0 };
  const candidates = new WeakSet<Request>();

  await context.route("**/*", async (route: Route, request: Request) => {
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return route.fallback();
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return route.fallback();
    const type = request.resourceType();
    if (blocked) {
      const reason = blocked(url, type, isMainFrameNavigation(request));
      if (reason) {
        stats.blocked++;
        return route.abort("blockedbyclient");
      }
    }
    if (cache && request.method() === "GET" && CACHED_TYPES.has(type)) {
      const headers = await request.allHeaders().catch(() => ({}) as Record<string, string>);
      if (headers.authorization === undefined) {
        const hit = await cache.get(request.url(), headers.origin);
        if (hit) {
          stats.hits++;
          const replay = Object.fromEntries(Object.entries(hit.meta.headers).filter(([k]) => !DROPPED_HEADERS.has(k)));
          return route.fulfill({ status: hit.meta.status, headers: replay, body: hit.body });
        }
        candidates.add(request);
      }
    }
    return route.fallback();
  });

  if (cache) {
    context.on("requestfinished", (request: Request) => {
      if (!candidates.has(request)) return;
      void (async () => {
        const response = await request.response();
        if (!response) return;
        const [reqHeaders, resHeaders] = await Promise.all([request.allHeaders(), response.allHeaders()]);
        if (!storable(request.method(), request.resourceType(), response.status(), reqHeaders, resHeaders)) return;
        const lifetime = freshness(resHeaders);
        if (lifetime === undefined) return;
        const body = await response.body();
        const varyOrigin = (resHeaders.vary ?? "").toLowerCase().includes("origin");
        const stored = await cache.put(
          {
            url: request.url(),
            status: response.status(),
            headers: resHeaders,
            expiresAt: Date.now() + lifetime,
            ...(varyOrigin ? { origin: reqHeaders.origin ?? null } : {}),
            size: body.length,
          },
          body,
        );
        if (stored) stats.stored++;
      })().catch(() => {});
    });
  }
  return stats;
}

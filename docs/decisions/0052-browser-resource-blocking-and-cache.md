# 0052. Opt-in resource blocking and an on-disk resource cache per identity

Date: 2026-11-18. Status: accepted. Builds on ADR 0044 (identities) and ADR 0048 (identity.json
format 2).

## Context

An agent reads pages; it rarely needs their ads, trackers or images, and every one of them costs
bandwidth, CPU and time before `load`. Research note 07 lists blocking and caching as the cheapest
wins other browser servers ship. Two constraints shape how turno can do it:

- Requests must keep leaving through Chrome. A request replayed from Node (`route.fetch`) carries
  Node's TLS fingerprint and headers, which bot defenses notice (ADR 0005).
- Playwright turns Chrome's HTTP cache off for the whole context as soon as anything intercepts
  requests (`Network.setCacheDisabled` follows `needsRequestInterception()`, pinned by the
  contract test). Blocking alone would make every page refetch every static file.

## Decision

Both are off by default and per identity, in identity.json (format 2):

```json
{
  "version": 2,
  "block": { "trackers": true, "types": ["image", "media", "font"], "patterns": ["ads.example", "*/promo/*"] },
  "cache": { "maxSize": "100MB" }
}
```

One context route (`src/resources.ts`), installed after upstream's own routes so it runs first
and hands what it does not handle on to them (`route.fallback`):

**Blocking** aborts a request with `blockedbyclient`, as an ad blocker would:

- `trackers`: a short built-in list of ad and analytics hosts and their subdomains (28 hosts:
  DoubleClick, Google Analytics and Tag Manager, Meta pixel, Criteo, Taboola, Hotjar, ...).
- `types`: `image`, `media`, `font`.
- `patterns`: a host name (matches it and its subdomains) or a URL glob where `*` matches
  anything (`*/promo/*`, `cdn.example/banners/*`); at most 500.
- The page itself (a main frame navigation) is never blocked; iframes are.

**The cache** keeps images, fonts, stylesheets and scripts on disk, under the identity's state
directory (`<state>/browser/identities/<id>/resource-cache`, removed with the identity), never
shared between identities and off without one:

- A miss goes on in Chrome; when the request finishes, the decoded body is stored if the response
  allows it. A fresh hit is served with `route.fulfill` from disk, without content-encoding,
  content-length, Set-Cookie or Age.
- Stored only: GET, status 200, one of those four types, no `Authorization` on the request, no
  `Set-Cookie` on the response, `Vary` on nothing but `Accept-Encoding` (the body is decoded) and
  `Origin` (kept with the entry and matched on a hit).
- Freshness as a private cache: `no-store` and `no-cache` are never stored; the lifetime is
  `max-age`, else `Expires` minus `Date`, less `Age`; nothing without a lifetime. No
  revalidation: a stale entry is deleted and fetched again.
- `maxSize` from 1 MB to 10 GB (default 100 MB); one entry at most a tenth of it (20 MB at most);
  least recently used entries go first past the cap. Directory mode 700, files mode 600, each
  written to a temporary name and renamed, the metadata last.

## Consequences

- With `block` and no `cache`, Chrome's HTTP cache is off for that identity, since any route
  turns it off; the docs say to pair them.
- Blocked images and fonts change what screenshots show, and blocking a tracker can break a site
  that waits for it; both are opt-in per identity for that reason.
- With `--allowed-origins` or `--blocked-origins`, upstream's routes still decide for whatever
  this route passes on.
- Tests: `test/resources.test.ts` (matching, freshness, what is stored, file modes, Origin,
  eviction) and a real-Chrome test that loads a page twice and again from a new server: the
  cacheable stylesheet is fetched once and still applies, `no-store` and `Set-Cookie` responses
  every time, the image type and the promo pattern never; a second identity shares nothing.
- Not done: `turno identity set` flags for `block` and `cache`, revalidation with ETag, a
  command that clears the cache (deleting the folder is safe).

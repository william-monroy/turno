---
"turno-browser": minor
---

Opt-in resource blocking and resource cache per identity (ADR 0052), both off by default:

- identity.json `block`: `trackers` (a built-in list of ad and analytics hosts), `types`
  (`image`, `media`, `font`) and `patterns` (host names or URL globs). The page itself is never
  blocked.
- identity.json `cache`: keeps images, fonts, stylesheets and scripts on disk for that identity
  only (`maxSize`, default 100MB, least recently used first), following `Cache-Control`, never
  storing a response with `Set-Cookie` or a request with `Authorization`. Misses still go out
  through Chrome; hits are served from disk.

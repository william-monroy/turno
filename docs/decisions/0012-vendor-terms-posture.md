# 0012. Stay on the permitted side of vendor terms: no tokens, opt-in fallback, neutral browser

Date: 2026-11-13. Status: accepted (the README wording should get a lawyer's review before
the first public release).

## Context

Anthropic's Claude Code terms allow a user to log into the unmodified Claude Code binary with
their own subscription, and forbid third parties from collecting, storing or brokering
Claude.ai credentials or session tokens, or routing requests with consumer-plan credentials.
Its usage policy forbids creating or using accounts to get around usage limits or safeguards;
OpenAI's terms have similar language. turno's switch to another account when one hits its
limit is the feature closest to that line.

The browser package was described as a "stealth" browser. Laws on tools for unauthorized
access (EU Directive 2013/40 article 7, Mexico's federal penal code article 211 bis 1) turn on
intent and on access without authorization, and a tool marketed for evasion reads worse than
the same tool described by what it does.

## Decision

- turno never reads, copies, stores or forwards the vendors' login tokens, and never proxies
  model traffic. Each agent logs in by itself in its own directory. SECURITY.md states this.
- The `fallback` setting stays off unless the user sets it (it already was: no default value),
  and the docs describe it as choosing which of your own accounts opens a folder, never as a
  way past limits. The README carries a vendor terms notice next to it.
- The browser is an optional package described by what it does (the installed Chrome with a
  persistent profile per identity), with an acceptable use section. "Stealth" stays out of
  user-facing text: package descriptions, README, CLI help. Internal names, code comments and
  earlier ADRs keep the word, since they record what was decided.
- The README states non-affiliation and nominative use of product names, no warranty, and
  what the update check sends.

## Consequences

- Feature work that would read, refresh or share vendor tokens (for example a usage meter that
  calls a vendor API with the user's OAuth token) is out of scope.
- The trademark question about the name itself (TURNO is registered in the US in classes 9 and
  42 by an unrelated company) is open and tracked in `docs/STATUS.md`.

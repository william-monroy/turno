# 0060. A landing page and the docs in one site, told as a story

Date: 2026-11-18. Status: accepted.

## Context

The documentation site (ADR 0046) opened with the gateway and its memory numbers. That is one
reason to use turno, but not where the project started or what most readers come for: turno
began as a way to use several accounts without losing the conversation, then grew MCP logins
done once per account, a browser per identity, skills that move work between accounts, and only
then the shared gateway. A home page that leads with RAM loses the readers who have the other
problems. The docs also looked like stock Fumadocs, with one long sidebar that held every area,
and they did not mention the Claude Code plugin at all.

## Decision

**One app, `apps/docs`, serves the landing page at `/` and the docs at `/docs`.** There is no
separate marketing site: one header, one search, one theme, and the landing's components can be
reused in the docs.

**The landing tells the whole story, in the order a reader feels it.** The headline is "Switch
accounts. Keep everything else." and the line under it is the moment itself: you change account
and the conversation keeps going. Eight chapters follow: the conversation that continues on
another account, MCP logins once per account, a browser per identity, skills between accounts,
how turno knows which account to use (the folder, kept short because it is the mechanism), the
shared gateway (the only place for the memory numbers, which come from BENCHMARKS.md and say
where they were measured), the agents it works with, and how safe it is to try. A strip under
the hero lets a reader start from their problem. Accounts are always separate work and personal
accounts, never a way around a plan's limits.

**Color means account.** Blue, the logo's color, is turno and what stays when the account
changes; violet is work, green is personal, amber is a third account. Color is not used with
any other meaning. The rest is paper and ink: hairlines, square corners, no decorative shadows
or gradients.

**A chapter is one picture that its commands drive.** The commands of a chapter are its
controls: choosing one (a click, the arrow keys, or scrolling on a wide screen) runs it in the
picture, and one line under the picture shows what was typed and what came of it. The
conversation is one object with one id across the whole page. A thin blue line runs down the
page from the hero, with the chapter numbers on it, in place of fixed navigation.

**The docs share the look and are split into three areas** (Docs, Reference, Troubleshooting),
each with its own sidebar; the written pages moved into a folder group that stays out of the
URL, so every address is unchanged. The troubleshooting index filters as the reader types. A
page that falls back to English under `/es` says so. A new concept page, Skills, covers the
plugin.

## Consequences

- The landing's words live in one file (`components/landing/copy.ts`), in English and Spanish;
  a chapter's picture keeps the few labels only it draws.
- Every command, line of output and number a picture shows has to exist in the repository; a
  picture cites its source in a comment, and a change to a command's output can make a picture
  stale. The pictures are not generated, so `docs:check` does not catch that.
- The hero and the pictures run in the browser (a canvas and plain DOM). With reduced motion
  each shows its final state, still.
- The site is deployed on Vercel from `apps/docs`, with Node 24.x.

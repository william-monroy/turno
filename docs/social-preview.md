# Social preview and avatar

`docs/assets/social-preview.png` is the repository's social preview (Settings > Social preview);
`docs/assets/social-preview.html` is its source, rendered at 1280x640 with a device scale of 2
(a 2560x1280 PNG) with the Chromium of `patchright-core`, the engine `packages/browser` already
depends on: open the HTML in a 1280x640 page with `deviceScaleFactor: 2`, wait for the fonts and
take a screenshot. GitHub takes images under 1 MB, so the PNG is saved again with the strongest
lossless compression; quantizing it to 256 colors bands the glow of the curtains.

The background, `docs/assets/social-preview-aurora.jpg`, is the landing page's hero
(turno.wimo.dev) captured at 1280x640 with a device scale of 2: a 1280x696 window, the header
above, the hero's text hidden, and the thread and its traveling message turned off (the
`uThreadFade` and `uPulse` uniforms set to zero), so only the three curtains of glyphs remain.
The account labels are placed by hand at each curtain's hem; capture again and move them if the
hero's composition changes.
`docs/assets/avatar.svg` and `avatar.png` are the avatar of the `wimo-dev` organization: the
mark on a full-bleed square, because GitHub rounds organization avatars itself.

## Why this design (study of 2026-11-16)

56 popular repositories in the same field (AI coding agents, MCP servers, developer CLIs):

- 22 (39%) upload their own image; the rest, including the three with the most stars, keep
  GitHub's generated card. The image does not make a project, but a new one has to say what it
  is, while an established brand can show only its name.
- Of the 22: 10 put the name or logo first (aider, opencode, biome, fzf, starship), 6 use brand
  art (Charm, Tailwind), 3 a headline with one visual (turborepo, firecrawl, GitHub CLI) and 3 a
  product screenshot (ccusage, warp, zoxide). 11 are dark; among AI coding agents, dark with a
  monospace wordmark is the norm.
- Almost all carry six words or fewer. None shows a benchmark number.

The card is mostly seen small: about 500 px wide on X, 360 px in Slack and Discord unfurls.
At 360 px, text set under about 44 px in the 1280 px image cannot be read. Five layouts were
rendered and compared at those sizes (name only, headline with diagram, benchmark number,
install command, name with a stat line). The headline with a diagram won: the name and the
headline stay readable at 360 px, and the diagram explains the product without words.

The card carries the narrative the README opens with: the headline "Switch accounts. Keep
everything else." and the hook "Switching accounts? Keep talking." Since the landing page got
its own look, the card uses it so the repository and the site read as one brand: paper and ink,
Geist at weight 500 with tight tracking, the landing's three curtains in the account tones (work
violet, client amber, personal green) as the picture, and blue only for what stays. The first
version showed four agent sessions joining one `mcpd`, and the second a conversation above an
account switch; the gateway is part of how turno works, not what the card says.
Memory numbers stay out of the image; they live in the README's Benchmark section and
BENCHMARKS.md.

# 0010. Apache License 2.0, a NOTICE file and machine-readable licensing

Date: 2026-11-13. Status: accepted.

## Context

The repository started under MIT. Before the first outside contribution the owner is the only
copyright holder, so the license can still change with one commit; after it, contributed code
keeps the license it came in under. The agent CLIs turno launches (Codex, Gemini CLI) and its
key dependencies (Playwright, Patchright, Meslo LG) are Apache-2.0. The fonts package
redistributes MesloLGS Nerd Font, whose icon sets carry several licenses, two of them
(Font Awesome, Codicons) CC BY 4.0, which requires attribution.

## Decision

- The code is under the Apache License 2.0: `LICENSE`, the `license` field of `turno`,
  `turno-browser`, the plugin and the workspace. Apache-2.0 adds an explicit patent grant with
  termination, the NOTICE mechanism, and an explicit exclusion of trademark rights.
- `NOTICE` names the copyright holder, the bundled fonts and the non-affiliation statement.
- `turno-fonts` keeps `SEE LICENSE IN LICENSE.txt`; that file now lists every icon set of the
  Nerd Fonts 3.4.0 license audit and attributes the CC BY 4.0 sets.
- `REUSE.toml` and `LICENSES/` make the licensing machine-readable without a header in every
  file; `uvx --from 'reuse[charset-normalizer]' reuse lint` passes.
- `scripts/licenses.mjs` (part of `pnpm check`) fails on any production dependency whose license
  is not on an allow list (GPL, AGPL, LGPL, SSPL, UNLICENSED and unknown fail), and on a stale
  `THIRD_PARTY_NOTICES.md`; `pnpm licenses` regenerates it.
- Contributions come in under the same license (inbound = outbound, as the GitHub terms already
  state), with the Developer Certificate of Origin (`Signed-off-by`) asked for in CONTRIBUTING.
  `Signed-off-by` is the human author's own sign-off, not a tool attribution. No CLA.

## Consequences

- Nothing changes for users; Apache-2.0 is as permissive as MIT for them.
- A new dependency with a license outside the list blocks `pnpm check` until someone reads it.

# 0038. Copying a claude.ai artifact between profiles

Date: 2026-11-17. Status: accepted.

## Context

A claude.ai artifact is private to the account that created it, and the Artifact tool cannot
change who has access. With several turno profiles, an artifact made in one account is often
needed in another (the work moved to that profile, or the first account ran out). Sharing from the
Share menu gives the other account access to the same artifact, which is right when both should
edit it. When the other account should own its own copy, the only way is to read the artifact in
a session of the owning account and publish it again in a session of the target account, because
each session reads and publishes only for its own account. The assets of an artifact (fonts,
images) live behind `/_blob/<id>` urls, and the ids change when they are uploaded again, so every
file that cites one has to be rewritten.

## Decision

**A third plugin skill, `copy-artifact`, in two steps.** Export runs in a session of the owning
profile: it reads the artifact's own files and assets with the Artifact tool and packs them.
Import runs in a session of the target profile: it creates the artifact (from the same type when
there is one, never another), uploads the assets, rewrites the references and publishes. The
export hands the import to a live session of the target profile with `SendMessage`, or gives the
user `turno <profile>` and `/copy-artifact import <package>`. The current profile is
`$TURNO_PROFILE`, which turno's launchers export, with `turno session handoff` (its `current:`
line) as the fallback.

**Two dependency-free Node ESM scripts in the skill folder.** `pack.mjs` and `relink.mjs` run on
the Node.js that runs turno, so the skill needs no Python and no install step; `allowed-tools`
names them through `${CLAUDE_SKILL_DIR}`, so they run without a permission prompt. They do the
parts a model gets wrong by hand: copying exactly the listed files, matching assets to the files
that cite them, and rewriting every `/_blob/<id>` with counts.

- `pack.mjs` writes `$XDG_CACHE_HOME/turno/artifacts/<slug>-<UTC stamp>/` (default
  `~/.cache/turno/artifacts`) with `files/`, `assets/` and `manifest.json` (source url, profile and
  type, title, main file, each file's size and SHA-256, each asset's file, reference count and
  SHA-256). It checks everything before it writes anything: a missing file, a path outside the
  source folder (as written and after resolving symlinks), a path named twice, an asset no file
  cites, a cited asset with no `--blob`, a bad or repeated `--blob`. stdout carries only the
  package path; notes go to stderr. Usage errors exit 2, the rest exit 1.
- `relink.mjs` rewrites the text files of the copy from a map `{"<old id>": "/_blob/<new id>"}`
  in one pass, so an id is never rewritten twice. It fails before writing on an id the map does
  not know, a value that is not a `/_blob/` url, a map that reuses an old id as a new one, and,
  with `--manifest`, a count that differs from the manifest's `references`; and afterwards if an
  old id is still there. It prints the count per asset.

**The package is private to the user.** Every profile's sessions run as the same user, so the
package folder is mode 700 and its files 600; nothing else on the machine needs to read it. An
earlier Python version of these scripts made the package world-readable, which was never needed.

## Consequences

- An artifact moves between accounts without the user downloading and uploading files by hand,
  and a missing asset or a stale reference stops the copy instead of producing a broken page.
- Comments, the artifact's database (ArtifactData) and the version history do not travel; the
  skill says so in its reply. Sharing stays the answer when one artifact should be edited from
  both accounts.
- Packages stay in the cache until the user deletes them. They are small and dated, and a later
  cleanup command can remove old ones.
- The tests (`scripts/copy-artifact.test.mjs`, node:test, part of `pnpm check`) run both scripts
  as child processes with a sandbox `HOME` and cover the happy paths and every failure.

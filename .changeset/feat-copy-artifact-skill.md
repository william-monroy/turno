---
"turno-cli": minor
---

The Claude Code plugin (0.2.0) adds a third skill, `copy-artifact`: it copies a claude.ai artifact (an HTML page, or one made from a type such as a Design canvas, a deck or a document) from one turno profile's account to another, with its own files and its assets (fonts, images). Export runs in a session of the owning profile and packs everything into `~/.cache/turno/artifacts/`; import runs in a session of the target profile, uploads the assets, rewrites the `/_blob/` references and publishes a new artifact. Two dependency-free Node scripts do the packing and the rewriting, and fail loudly on a missing file, a path outside the source folder, an asset no file cites, a cited asset that was not passed, an unknown id or a count that differs from the manifest. Comments, the artifact's database and its version history do not travel; sharing from the Share menu stays the way to edit one artifact from both accounts.

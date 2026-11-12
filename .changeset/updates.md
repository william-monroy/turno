---
"claudio": minor
---

claudio knows its version and how it was installed: `claudio upgrade` updates it with the
same tool (npm, pnpm, yarn, bun, volta or a git checkout), rewrites the launchers and shows
what changed. Interactive commands look for a new release once a day in the background
(`update_check = false` or `CLAUDIO_NO_UPDATE_CHECK=1` turns that off).

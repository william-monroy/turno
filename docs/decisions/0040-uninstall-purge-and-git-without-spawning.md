# 0040. uninstall --purge, and the git common dir without spawning git

Date: 2026-11-17. Status: accepted. Refines ADR 0025 (uninstall) and ADR 0034 (startup speed).

## Context

`turno uninstall` (ADR 0025) keeps turno's state folder on purpose: the journal that makes the
uninstall undoable lives there. Someone who is done with turno still has to find and delete
`~/.local/state/turno`, `~/.cache/turno` and the MCP servers turno installed under
`~/.local/share/turno` by hand.

The status line, `turno auto` and `turno resolve` resolve a folder on every uncached run, and
`candidateRoots` ran `git rev-parse --git-common-dir` each time to find the main repository of a
worktree. Spawning git costs more than the rest of the resolve.

## Decision

**`turno uninstall --purge`.** The same list and the same confirmation (`--yes`, or a terminal
to answer in; exit 2 otherwise). It first does everything a plain uninstall does, through the
journal, then removes whole and without a journal: the state folder (backups, logs, usage,
exhausted marks, the journal just written), `~/.cache/turno`, `servers/` and `mcpd/` under the
data folder, and the data folder itself when nothing else is left in it. It keeps what holds a
login (profile folders, `chrome/` and `browser/` under the data folder) and the secrets in the
Keychain or Secret Service. The closing line says that `turno undo` cannot put it back, instead
of offering the undo. A state folder that is the root, the home folder or one that holds it (a
`TURNO_STATE_DIR` set by mistake) is never removed. Without `--purge` nothing changed.

**The git common dir from the file system.** `candidateRoots` walks up from the folder to the
first `.git`, follows a `gitdir:` file (worktrees and submodules) and a worktree's `commondir`,
stops at a file system boundary as git does, and returns the real path. It asks git as before
for anything unusual: git's discovery variables set (`GIT_DIR`, `GIT_COMMON_DIR`,
`GIT_WORK_TREE`, `GIT_CEILING_DIRECTORIES`, `GIT_DISCOVERY_ACROSS_FILESYSTEM`), a repository
another user owns (git's `safe.directory` decides), a `.git` file without a `gitdir:` line, a
missing `HEAD` or `objects`, a folder that does not exist.

## Consequences

- `--purge` cannot be undone; the list, the confirmation and the closing line say so.
- A test compares `candidateRoots` with `git rev-parse` for repositories, subfolders, the `.git`
  folder itself, worktrees, submodules, a linked folder and a linked `.git`, and checks that git
  runs only for the unusual cases.
- On a heavily loaded machine (median of 40 interleaved runs): `turno resolve` in a worktree
  92 ms to 66 ms, in a repository subfolder 95 ms to 78 ms; an uncached status line in a
  profile's session 100 ms to 69 ms.

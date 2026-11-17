#!/usr/bin/env bash
# The clean shell the VHS tape records in (docs/demo/demo.tape). Run it with exec from the
# repository root, after pnpm build:
#
#   exec docs/demo/setup.sh
#
# It replaces the current shell with a bash that has an empty environment: a throwaway HOME, a
# PATH with only the system folders and a `turno` that runs this checkout, and a neutral user
# name. Nothing from your own HOME, PATH or agent variables reaches the recording, so it shows no
# real path, name or account. Inside it, `turno demo` builds its own throwaway HOME (two profiles,
# a gateway, two MCP servers), opens a shell there and removes everything when that shell exits.
# Remove the folder this script prints with `rm -rf "$TURNO_VHS"` when you are done.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
ENTRY="$ROOT/packages/turno/dist/cli/main.js"
[ -f "$ENTRY" ] || { echo "setup.sh: build first: pnpm build" >&2; exit 1; }
NODE="$(command -v node)" || { echo "setup.sh: node is not on PATH" >&2; exit 1; }

# /tmp, not $TMPDIR: on macOS that is a long per-user folder, and the demo prints its path.
BASE="$(cd /tmp && pwd -P)/turno-vhs"
rm -rf "$BASE"
mkdir -p "$BASE/bin" "$BASE/home"

# A copy of node, not a link: the demo's MCP servers run as node's real path (process.execPath),
# and `turno mcp list` shows it. A copy keeps a version manager's folder under your HOME out of
# the recording. On APFS, cp -c makes a clone that takes no space.
cp -c "$NODE" "$BASE/bin/node" 2>/dev/null || cp "$NODE" "$BASE/bin/node"
printf '#!/bin/sh\nexec %q %q "$@"\n' "$BASE/bin/node" "$ENTRY" >"$BASE/bin/turno"
chmod 755 "$BASE/bin/turno"

SHELL_BIN=/bin/zsh
[ -x "$SHELL_BIN" ] || SHELL_BIN=/bin/bash

cd "$BASE/home"
exec env -i \
  HOME="$BASE/home" \
  PATH="$BASE/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  TMPDIR=/tmp \
  USER=demo LOGNAME=demo \
  SHELL="$SHELL_BIN" \
  TERM="${TERM:-xterm-256color}" COLORTERM=truecolor \
  LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \
  TURNO_NO_UPDATE_CHECK=1 \
  TURNO_VHS="$BASE" \
  PS1='$ ' \
  /bin/bash --noprofile --norc -i

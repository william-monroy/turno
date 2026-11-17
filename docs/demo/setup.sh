#!/usr/bin/env bash
# The clean shell the VHS tape records in (docs/demo/demo.tape). Run it with exec from the
# repository root, after pnpm build:
#
#   exec docs/demo/setup.sh
#
# It replaces the current shell with a bash that has an empty environment: a throwaway HOME, a
# PATH with only the system folders, a `turno` that runs this checkout, a `claude` stand-in that
# only answers `auth status` for two example accounts, and a neutral user name. Nothing from your own HOME, PATH or agent variables reaches the recording, so it shows no
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

# A stand-in for Claude Code, so the recording shows signed-in accounts without a real agent or
# a real login. It answers only what turno asks (claude auth status --json, claude --version)
# and refuses everything else, so no profile can start an agent through it.
cat >"$BASE/bin/claude" <<'STUB'
#!/bin/sh
# claude for the turno README recording: not Claude Code. It never runs an agent.
case "$1 $2" in
"--version "*) echo "2.1.0 (Claude Code)" ;;
"auth status")
  case "${CLAUDE_CONFIG_DIR##*/}" in
  .claude-work) echo '{"loggedIn":true,"authMethod":"claude.ai","email":"you@work.example","orgName":"Acme","subscriptionType":"max"}' ;;
  .claude-personal) echo '{"loggedIn":true,"authMethod":"claude.ai","email":"you@personal.example","subscriptionType":"pro"}' ;;
  *) echo '{"loggedIn":false}' ;;
  esac
  ;;
*)
  echo "claude: a stand-in for the turno recording; it does not run Claude Code" >&2
  exit 2
  ;;
esac
STUB

# Run inside the demo shell before the visible part: what a few days of use leaves behind.
# Usage snapshots in the shape the status line records them (state/usage/<profile>.json), and
# the bundled font in the demo HOME's own font folder (not turno ui install, which also changes
# terminal settings outside HOME).
cat >"$BASE/bin/turno-demo-seed" <<SEED
#!/bin/sh
set -eu
now=\$(date +%s)
usage="\$HOME/.local/state/turno/usage"
mkdir -p "\$usage"
snap() { # profile 5h% 5h-reset-seconds week% week-reset-seconds
  printf '{"rate_limits":{"five_hour":{"used_percentage":%s,"resets_at":%s},"seven_day":{"used_percentage":%s,"resets_at":%s}},"updated_at":%s}\\n' \\
    "\$2" "\$((now + \$3))" "\$4" "\$((now + \$5))" "\$((now - 120))" >"\$usage/\$1.json"
}
snap personal 42 10800 18 345600
snap work 87 3600 64 172800
case "\$(uname)" in
Darwin) fonts="\$HOME/Library/Fonts" ;;
*) fonts="\$HOME/.local/share/fonts" ;;
esac
mkdir -p "\$fonts"
cp $(printf '%q' "$ROOT/packages/fonts/fonts")/*.ttf "\$fonts/"
SEED
chmod 755 "$BASE/bin/turno" "$BASE/bin/claude" "$BASE/bin/turno-demo-seed"

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
  TURNO_NO_UPDATE_CHECK=1 BASH_SILENCE_DEPRECATION_WARNING=1 \
  TURNO_VHS="$BASE" \
  PS1='$ ' \
  /bin/bash --noprofile --norc -i

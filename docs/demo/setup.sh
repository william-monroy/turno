#!/usr/bin/env bash
# Builds the throwaway HOME the demo runs in. Never touches your own config.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEMO="$(cd "${TMPDIR:-/tmp}" && pwd -P)/turno-demo"
rm -rf "$DEMO" && mkdir -p "$DEMO/.local/bin" "$DEMO/code/acme" "$DEMO/.config/turno" "$DEMO/.claude" "$DEMO/.codex"
ln -s "$ROOT/packages/turno/dist/cli/main.js" "$DEMO/.local/bin/turno"
cp "$ROOT/docs/demo/mcp.toml" "$DEMO/.config/turno/mcp.toml"
printf '[mcpd]\nport = 47998\n' > "$DEMO/.config/turno/config.toml"
export HOME="$DEMO" PATH="$DEMO/.local/bin:$PATH" TURNO_NO_UPDATE_CHECK=1
turno profile add work --color violet >/dev/null
turno profile add personal >/dev/null
turno config set default personal >/dev/null
echo "$DEMO"

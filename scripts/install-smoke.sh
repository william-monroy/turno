#!/usr/bin/env bash
# Install the packed turno-cli and turno-browser with one package manager, in a throwaway HOME
# and a throwaway global prefix, then check that the installed `turno` runs:
#
#   scripts/install-smoke.sh <manager> <folder with the packed workspace packages (*.tgz)>
#
# The folder holds turno-cli and turno-browser and every workspace package they depend on
# (turno-core). Those may not be on npm yet, so a local registry (scripts/local-registry.mjs)
# serves the folder's tarballs and forwards everything else to registry.npmjs.org, and every
# manager installs through it.
#
# <manager> is npm, pnpm, bun or yarn (global installs), or npx, pnpm-dlx or bunx (one-off runs
# of turno-cli). Every folder a manager writes (prefix, store, cache, global folder) is under a
# temporary directory that is removed at the end: nothing outside it changes. The install
# workflow runs it on Linux and macOS; run it locally the same way.
set -euo pipefail

manager=${1:?usage: install-smoke.sh <npm|pnpm|bun|yarn|npx|pnpm-dlx|bunx> <tarball folder>}
tarballs=$(cd "${2:?usage: install-smoke.sh <manager> <tarball folder>}" && pwd)
cli=$(ls "$tarballs"/turno-cli-*.tgz)
browser=$(ls "$tarballs"/turno-browser-*.tgz)
version=$(tar -xzOf "$cli" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')

work=$(mktemp -d "${TMPDIR:-/tmp}/turno-install-smoke.XXXXXX")
registry_pid=""
trap '[ -n "$registry_pid" ] && kill "$registry_pid" 2>/dev/null; rm -rf "$work"' EXIT
mkdir -p "$work/home" "$work/tmp"

# The local registry: the packed workspace packages, and npmjs for the rest.
node "$(dirname "$0")/local-registry.mjs" "$tarballs" >"$work/registry.url" 2>"$work/registry.log" &
registry_pid=$!
disown "$registry_pid"
for _ in $(seq 1 50); do [ -s "$work/registry.url" ] && break; sleep 0.1; done
registry=$(cat "$work/registry.url")
[ -n "$registry" ] || { cat "$work/registry.log" >&2; echo "the local registry did not start" >&2; exit 1; }

# A throwaway HOME and XDG folders, and every manager's global folder inside $work.
export HOME="$work/home"
export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share" XDG_STATE_HOME="$HOME/.local/state" XDG_CACHE_HOME="$HOME/.cache"
export TMPDIR="$work/tmp"
export npm_config_cache="$work/npm-cache" npm_config_update_notifier=false
# npm and yarn 1 read npm_config_*, pnpm 11 and later pnpm_config_*, bun its own variable.
export npm_config_registry="$registry" pnpm_config_registry="$registry" BUN_CONFIG_REGISTRY="$registry"
export PNPM_HOME="$work/pnpm-home"
export BUN_INSTALL="$work/bun"
export TURNO_NO_UPDATE_CHECK=1
# pnpm 11 and later link global commands into $PNPM_HOME/bin, older ones into $PNPM_HOME.
export PATH="$work/npm-prefix/bin:$PNPM_HOME/bin:$PNPM_HOME:$BUN_INSTALL/bin:$work/yarn-prefix/bin:$PATH"
cd "$work"

say() { printf '\n== %s\n' "$*"; }
die() {
  printf 'FAIL (%s): %s\n' "$manager" "$*" >&2
  exit 1
}

# How each manager installs both packages globally, or runs turno-cli once. A turno-cli tarball
# alone is enough for a one-off run: turno-browser is optional. turno-core comes from the local
# registry as a dependency of both.
run=()
case "$manager" in
  npm) npm install --global --prefix "$work/npm-prefix" "$cli" "$browser" ;;
  pnpm) pnpm add --global --registry "$registry" "turno-cli@file:$cli" "turno-browser@file:$browser" ;;
  bun) bun add --global "$cli" "$browser" ;;
  yarn) yarn global add "file:$cli" "file:$browser" --registry "$registry" --prefix "$work/yarn-prefix" --global-folder "$work/yarn-global" --cache-folder "$work/yarn-cache" ;;
  npx) run=(npx --yes --package "file:$cli" -- turno) ;;
  pnpm-dlx) run=(pnpm --registry "$registry" --package "turno-cli@file:$cli" dlx turno) ;;
  bunx) run=(bunx --package "$cli" turno) ;;
  *) die "unknown manager" ;;
esac
if [ ${#run[@]} -eq 0 ]; then
  turno_bin=$(command -v turno) || die "turno is not on PATH after the install"
  case "$turno_bin" in "$work"/*) ;; *) die "turno resolved outside the throwaway prefix: $turno_bin" ;; esac
  run=("$turno_bin")
fi
turno() { "${run[@]}" "$@"; }

say "turno --version"
out=$(turno --version)
echo "$out"
[ "$out" = "turno $version" ] || die "expected 'turno $version'"

say "turno doctor --summary"
turno doctor --summary || die "turno doctor --summary failed"

say "turno version --json"
json=$(turno version --json)
echo "$json"
method=$(node -p 'JSON.parse(process.argv[1]).method' "$json")
[ "$method" = "$manager" ] || die "turno upgrade would treat this as a $method install"

# What `turno upgrade` must run for each global install (core/version.ts).
case "$manager" in
  npm) expected="npm install --global" ;;
  pnpm) expected="pnpm add --global" ;;
  bun) expected="bun add --global" ;;
  yarn) expected="yarn global add" ;;
  *) expected="" ;;
esac

say "turno upgrade --dry-run"
case "$manager" in
  npx | pnpm-dlx | bunx)
    turno upgrade --dry-run | tee "$work/upgrade.txt"
    grep -q "runs the newest release" "$work/upgrade.txt" || die "upgrade did not explain the one-off run"
    ;;
  *)
    turno upgrade --dry-run --to 99.0.0 | tee "$work/upgrade.txt"
    grep -qF "\$ $expected turno-cli@99.0.0" "$work/upgrade.txt" || die "upgrade would not use $expected"
    say "turno browser identities (turno-browser installed next to turno)"
    turno browser identities --json || die "turno did not find turno-browser"
    command -v turno-browser-mcp >/dev/null || die "turno-browser-mcp is not on PATH"
    turno-browser-mcp --help >/dev/null || die "turno-browser-mcp --help failed"
    ;;
esac

say "nothing outside the throwaway folders"
[ -z "$(ls -A "$HOME/.local/bin" 2>/dev/null)" ] || die "something wrote launchers into HOME"
echo "ok: $manager installs and runs turno $version"

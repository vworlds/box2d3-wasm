#!/usr/bin/env bash
# Run the vecs test suites that exercise this package.
#
#   scripts/run-vecs-suites.sh <vecs-checkout> <tarball-or-package-dir>
#
# <tarball-or-package-dir> is the output of `npm pack` (a .tgz) or a directory with the built
# package (package.json and dist/).
#
# Steps: npm ci in the vecs checkout, replace every node_modules/@vworlds/box2d3-wasm (and any
# leftover unscoped node_modules/box2d3-wasm) in it with a real
# copy of the package (not a symlink), then run the vitest suites of @vworlds/vecs-physics,
# @vworlds/vecs-phaser-server and @vworlds/vecs-phaser. vecs is not built first: its tests run
# from source, so a checkout that already holds `dist` directories is refused.
# All three suites run even when one fails; the exit status is non-zero if any did.
#
# SKIP_NPM_CI=1 reuses the node_modules already in the checkout (local iteration only).
set -euo pipefail

if [[ $# -ne 2 ]]; then
  >&2 echo "usage: $0 <vecs-checkout> <tarball-or-package-dir>"
  exit 2
fi
VECS="$(cd "$1" && pwd)"
PKG_ARG="$(realpath "$2")"
SUITES=(@vworlds/vecs-physics @vworlds/vecs-phaser-server @vworlds/vecs-phaser)

[[ -f "$VECS/package.json" && -d "$VECS/lib" ]] || { >&2 echo "not a vecs checkout: $VECS"; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [[ -f "$PKG_ARG" ]]; then
  tar -xzf "$PKG_ARG" -C "$TMP"
  PKG="$TMP/package"
elif [[ -d "$PKG_ARG" ]]; then
  PKG="$PKG_ARG"
else
  >&2 echo "no such tarball or directory: $2"
  exit 2
fi
[[ -f "$PKG/package.json" && -f "$PKG/dist/entry.mjs" ]] || { >&2 echo "$PKG is not a built package (package.json, dist/entry.mjs)"; exit 2; }

if [[ -n "$(find "$VECS" -name dist -type d -not -path '*/node_modules/*' -prune -print -quit)" ]]; then
  >&2 echo "the vecs checkout contains dist directories; the suites must run from source. Use a clean checkout."
  exit 2
fi

cd "$VECS"
if [[ "${SKIP_NPM_CI:-0}" != 1 ]]; then
  npm ci
fi

# Replace every installed copy (the hoisted one, and any nested under a workspace).
# vecs depends on the scoped name; the unscoped one is matched too for older vecs commits.
mapfile -t TARGETS < <(find . -path ./.worktrees -prune -o -type d -name box2d3-wasm \( -path '*/node_modules/@vworlds/box2d3-wasm' -o -path '*/node_modules/box2d3-wasm' \) -prune -print)
[[ ${#TARGETS[@]} -gt 0 ]] || TARGETS=(./node_modules/@vworlds/box2d3-wasm)
for target in "${TARGETS[@]}"; do
  rm -rf "$target"
  mkdir -p "$(dirname "$target")"
  cp -r "$PKG" "$target"
  [[ ! -L "$target" ]] || { >&2 echo "$target is a symlink"; exit 1; }
  echo "installed $(node -p "const p=require('$target/package.json'); p.name+'@'+p.version") at $target"
done

status=0
declare -A RESULT
for suite in "${SUITES[@]}"; do
  echo "::group::npm run test -w $suite"
  if npm run test -w "$suite"; then RESULT[$suite]=pass; else RESULT[$suite]=FAIL; status=1; fi
  echo "::endgroup::"
done

echo
echo "vecs suites against $(node -p "require('$PKG/package.json').version"):"
for suite in "${SUITES[@]}"; do echo "  ${RESULT[$suite]}  $suite"; done
exit $status

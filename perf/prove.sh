#!/usr/bin/env bash
# Proof kit for one fork build (CHECKPOINT.md §2.5). Fails on the first deviation.
#
#   perf/prove.sh <build-dir> [--quick]
#
# Env: VECS_SCRATCH (scratch adapter checkout, default ../vecs-scratch),
#      VECS_STOCK (unmodified vecs checkout, default ../vecs-stock),
#      PKG_USE (script that points a checkout's box2d3-wasm at a build, default perf/use-build.sh;
#      it honours PKG_ROOT, default /home/user/pkg).
# --quick skips the vecs test suites.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$(realpath "$1")"
QUICK="${2:-}"
VECS_SCRATCH="$(realpath "${VECS_SCRATCH:-$ROOT/../vecs-scratch}")"
VECS_STOCK="$(realpath "${VECS_STOCK:-$ROOT/../vecs-stock}")"
PKG_USE="${PKG_USE:-$ROOT/perf/use-build.sh}"

declare -A REF=(
  [drift500]=11c76fa7 [drift2000]=a66a94ee [drift10000]=70623967 [contact]=5db7f953
  [worlds25x19]=a8a0671e [rest2000]=17fc310b [drive500]=fd7cc876
)

checksums() { # <label> <vecs root>
  for scene in drift500 drift2000 drift10000 contact worlds25x19 rest2000 drive500; do
    line=$(BENCH_VECS_ROOT="$2" BOX2D_ENTRY="$BUILD/entry.mjs" \
      node --import "$ROOT/perf/bench/register.mjs" "$ROOT/perf/bench/vecs-tick.ts" "$scene" | grep TICK_RESULT)
    sum=$(sed 's/.*"checksum":"\([0-9a-f]*\)".*/\1/' <<<"$line")
    if [[ "$sum" != "${REF[$scene]}" ]]; then
      echo "FAIL $1 $scene checksum $sum != ${REF[$scene]}"; exit 1
    fi
    echo "ok   $1 $scene $sum"
  done
}

suites() { # <label> <vecs root> <pkg name>
  "$PKG_USE" "$3" "$BUILD" >/dev/null
  for w in vecs-physics vecs-phaser-server vecs-phaser; do
    log=$(mktemp)
    if ! (cd "$2" && npm run test -w "@vworlds/$w" >"$log" 2>&1); then
      echo "FAIL $1 $w"; grep -E "×|FAIL" "$log" | head -20; exit 1
    fi
    echo "ok   $1 $w $(grep -E 'Tests +[0-9]' "$log" | tail -1 | sed 's/ \+/ /g')"
  done
}

echo "== differential test"
BOX2D_ENTRY="$BUILD/entry.mjs" node "$ROOT/perf/tests/fastpath-differential.mjs"
if [[ -f "$BUILD/compat/Box2D.compat.mjs" ]]; then
  BOX2D_FLAVOUR_FILE="$BUILD/compat/Box2D.compat.mjs" node "$ROOT/perf/tests/fastpath-differential.mjs"
fi
echo "== checksums, scratch adapter"
checksums scratch "$VECS_SCRATCH"
echo "== checksums, unmodified vecs (embind API)"
checksums unmodified "$VECS_STOCK"
if [[ "$QUICK" != "--quick" ]]; then
  echo "== vecs suites, scratch adapter"
  suites scratch "$VECS_SCRATCH" "$(basename "$VECS_SCRATCH")"
  echo "== vecs suites, unmodified vecs"
  suites unmodified "$VECS_STOCK" "$(basename "$VECS_STOCK")"
fi
echo "PROOF OK $BUILD"

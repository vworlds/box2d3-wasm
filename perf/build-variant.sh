#!/usr/bin/env bash
# Build the deluxe (and optionally compat) flavour into a named directory for benchmarking.
#   perf/build-variant.sh <out-dir> [extra emcc flags...]
# Env: FLAVOURS="deluxe compat" (default deluxe), TARGET_TYPE (default Release),
#      REBUILD_LIB=1 to re-run cmake + make for the Box2D static library first.
# Requires emsdk 4.0.18 on PATH and TypeScript 5 as `tsc` (emcc --emit-tsd breaks on TS 6).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(realpath -m "$1")"; shift
export TARGET_TYPE="${TARGET_TYPE:-Release}"
export EXTRA_EMCC_OPTS="$*"
cd "$ROOT/box2d3-wasm"
for F in ${FLAVOURS:-deluxe}; do
  if [[ "${REBUILD_LIB:-0}" == 1 || ! -d "cmake-build-$F" ]]; then
    rm -rf "cmake-build-$F" # CMake caches CFLAGS from the first configure
    FLAVOUR=$F ./shell/0_build_makefile.sh
    emmake make -j"$(nproc)" -C "cmake-build-$F"
  fi
  FLAVOUR=$F ./shell/1_build_wasm.sh
  mkdir -p "$OUT/$F"
  cp build/dist/es/$F/Box2D.$F.{mjs,wasm,d.ts} "$OUT/$F/"
done
cp build/dist/es/entry.mjs build/dist/es/entry.d.ts build/dist/es/fastpath.mjs build/dist/es/fastpath.d.ts build/dist/es/fastpath_body.gen.d.ts "$OUT/"
echo "built $OUT"

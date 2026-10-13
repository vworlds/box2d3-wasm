#!/usr/bin/env bash
# Build the package into dist/.
#
#   scripts/build.sh                                  # deluxe + compat, Release
#   FLAVOURS=deluxe TARGET_TYPE=Debug scripts/build.sh
#
# Steps, per flavour: apply patches/box2d to the Box2D submodule (idempotent), configure and build
# the Box2D static library with emcmake/make, link it with the glue and fast-path sources with
# emcc, post-process the TypeScript declarations. Everything intermediate goes to build/; the
# result goes to dist/.
#
# Requires emsdk 4.0.18 on PATH (emcc, emcmake, emmake), TypeScript 5 as `tsc` (emcc --emit-tsd
# breaks on TypeScript 6), cmake, make, git, gawk. scripts/build-in-docker.sh provides all of it.
#
# The output does not depend on where the repository is checked out: -ffile-prefix-map rewrites
# the repository root and the emsdk root in every compile and in the link.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOX2D_DIR="$ROOT/box2d"
BUILD_DIR="$ROOT/build"
DIST_DIR="$ROOT/dist"
FLAVOURS="${FLAVOURS:-deluxe compat}"
TARGET_TYPE="${TARGET_TYPE:-Release}"

Red='\033[0;31m'
Green='\033[0;32m'
Blue='\033[0;34m'
NC='\033[0m'
die() { >&2 echo -e "${Red}$*${NC}"; exit 1; }

for tool in emcc emcmake emmake cmake make git tsc awk; do
  command -v "$tool" >/dev/null || die "missing tool on PATH: $tool"
done
[[ -f "$BOX2D_DIR/include/box2d/box2d.h" ]] || die "box2d submodule is empty; run: git submodule update --init box2d"
case "$TARGET_TYPE" in
  Debug | RelWithDebInfo | Release) ;;
  *) die "TARGET_TYPE must be Debug, RelWithDebInfo or Release (got '$TARGET_TYPE')" ;;
esac
>&2 echo "TARGET_TYPE is $TARGET_TYPE, FLAVOURS is '$FLAVOURS'"

# ---- path-independence: map the repository root and the emsdk root to fixed relative prefixes.
# Later maps win, so the emscripten root (inside the emsdk root) comes last.
EMSCRIPTEN_ROOT="$(dirname "$(realpath "$(command -v emcc)")")"
PREFIX_MAPS=("-ffile-prefix-map=$ROOT=.")
if [[ -n "${EMSDK:-}" && -d "$EMSDK" ]]; then
  PREFIX_MAPS+=("-ffile-prefix-map=$(realpath "$EMSDK")=emsdk")
fi
PREFIX_MAPS+=("-ffile-prefix-map=$EMSCRIPTEN_ROOT=emscripten")

# ---- patches against the Box2D submodule (see patches/README.md). Idempotent: a patch that
# already applies in reverse is already in place.
for patch in "$ROOT"/patches/box2d/*.patch; do
  [[ -e "$patch" ]] || continue
  if git -C "$BOX2D_DIR" apply --reverse --check "$patch" 2>/dev/null; then
    >&2 echo "patch already applied: $(basename "$patch")"
  else
    git -C "$BOX2D_DIR" apply "$patch"
    >&2 echo "applied patch: $(basename "$patch")"
  fi
done

mkdir -p "$BUILD_DIR" "$DIST_DIR"

build_flavour() {
  local FLAVOUR="$1"
  local CMAKE_OPTS=() CFLAGS=() CXXFLAGS=() FLAVOUR_EMCC_OPTS=()
  case "$FLAVOUR" in
    compat)
      CMAKE_OPTS+=(-DBOX2D_DISABLE_SIMD=ON)
      ;;
    deluxe)
      CMAKE_OPTS+=(-DBOX2D_DISABLE_SIMD=OFF)
      # -msimd128 -msse2 are probably redundant (Box2D's CMake applies them), harmless duplicated.
      CFLAGS+=(-msimd128 -msse2)
      CXXFLAGS+=(-msimd128 -msse2)
      FLAVOUR_EMCC_OPTS+=(-msimd128 -msse2)
      ;;
    *)
      die "unknown flavour '$FLAVOUR' (expected deluxe or compat)"
      ;;
  esac

  # Release compiles the Box2D library with LTO, so the link (also -flto) can inline across the
  # glue/fast path and Box2D. No fast-math, no FMA contraction (Box2D sets -ffp-contract=off).
  if [[ "$TARGET_TYPE" == "Release" ]]; then
    CFLAGS+=(-flto)
    CXXFLAGS+=(-flto)
  fi
  CFLAGS+=("${PREFIX_MAPS[@]}")
  CXXFLAGS+=("${PREFIX_MAPS[@]}")

  # ---- Box2D static library
  local CMAKE_DIR="$BUILD_DIR/cmake-$FLAVOUR"
  rm -rf "$CMAKE_DIR" # CMake caches CFLAGS from the first configure
  >&2 echo -e "${Blue}[$FLAVOUR] configuring Box2D${NC}"
  (
    set -x
    CFLAGS="${CFLAGS[*]}" CXXFLAGS="${CXXFLAGS[*]}" \
    emcmake cmake \
      -DCMAKE_BUILD_TYPE="$TARGET_TYPE" \
      -B"$CMAKE_DIR" \
      -S"$BOX2D_DIR" \
      "${CMAKE_OPTS[@]}" \
      -DBOX2D_VALIDATE=OFF \
      -DBOX2D_SAMPLES=OFF \
      -DBOX2D_UNIT_TESTS=OFF \
      -DBOX2D_DOCS=OFF
  )
  >&2 echo -e "${Blue}[$FLAVOUR] building Box2D${NC}"
  emmake make -j"$(nproc)" -C "$CMAKE_DIR"

  # ---- link
  local EMCC_OPTS=(
    -std=c++20
    -s MODULARIZE=1
    -s EXPORT_NAME=Box2D
    -s ALLOW_TABLE_GROWTH=1
    -s FILESYSTEM=0
    -s EXPORTED_FUNCTIONS=_malloc,_free
    -s EXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU16,HEAPU32,HEAP32,HEAPF32,wasmMemory
    -s ALLOW_MEMORY_GROWTH=1
    -s EXPORT_ES6=1
    "${FLAVOUR_EMCC_OPTS[@]}"
  )
  local LIBARCHIVE
  case "$TARGET_TYPE" in
    Debug)
      LIBARCHIVE="libbox2dd.a"
      EMCC_OPTS+=(-g3 -gsource-map -s ASSERTIONS=2)
      ;;
    RelWithDebInfo)
      LIBARCHIVE="libbox2d.a"
      EMCC_OPTS+=(-O3 -g3 -gsource-map)
      ;;
    Release)
      LIBARCHIVE="libbox2d.a"
      # Not minified or mangled: the output is kept readable.
      EMCC_OPTS+=(
        -O3
        --minify 0
        --closure 0
        -flto
        -s "EXPORTED_RUNTIME_METHODS=['HEAPU8','HEAPU16','HEAPU32','HEAP32','HEAPF32','wasmMemory','stackSave','stackRestore','stackAlloc']"
        -s STACK_OVERFLOW_CHECK=2
      )
      ;;
  esac
  EMCC_OPTS+=("${PREFIX_MAPS[@]}")

  local BASENAME="Box2D.$FLAVOUR"
  local OUT_DIR="$BUILD_DIR/emcc-$FLAVOUR"
  rm -rf "$OUT_DIR"
  mkdir -p "$OUT_DIR"
  >&2 echo -e "${Blue}[$FLAVOUR] linking${NC}"
  (
    cd "$ROOT" # relative source paths, so the command line itself carries no host path
    set -x
    emcc -lembind \
      src/glue.cpp \
      src/fastpath.cpp \
      src/fastpath_body.gen.cpp \
      "${CMAKE_DIR#"$ROOT"/}/src/$LIBARCHIVE" \
      -I box2d/include \
      "${EMCC_OPTS[@]}" \
      -o "${OUT_DIR#"$ROOT"/}/$BASENAME.mjs" \
      --emit-tsd "$OUT_DIR/$BASENAME.d.ts"
  )

  # ---- assemble dist/<flavour>
  local FLAVOUR_DIST="$DIST_DIR/$FLAVOUR"
  rm -rf "$FLAVOUR_DIST"
  mkdir -p "$FLAVOUR_DIST"
  cp "$OUT_DIR/$BASENAME.mjs" "$OUT_DIR/$BASENAME.wasm" "$FLAVOUR_DIST/"
  # replace emcc's `export default function MainModuleFactory` declaration with our template
  awk -f "$ROOT/scripts/modify_emscripten_dts.awk" -v template="$ROOT/src/Box2D.template.d.ts" \
    "$OUT_DIR/$BASENAME.d.ts" > "$FLAVOUR_DIST/$BASENAME.d.ts"
  >&2 echo -e "${Green}[$FLAVOUR] built $FLAVOUR_DIST/$BASENAME.{mjs,wasm,d.ts}${NC}"
}

for FLAVOUR in $FLAVOURS; do
  build_flavour "$FLAVOUR"
done

# flavour-independent files
cp "$ROOT"/src/{entry.mjs,entry.d.ts,fastpath.mjs,fastpath.d.ts,fastpath_body.gen.d.ts} "$DIST_DIR/"
>&2 echo -e "${Green}dist/ is ready${NC}"

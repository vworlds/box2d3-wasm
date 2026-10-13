#!/usr/bin/env bash
# Create a local vecs checkout for the perf harness and the proof kit (never pushed).
#
#   perf/setup-vecs-checkout.sh <vecs-clone> <target-dir> stock|scratch
#
# stock:   detached worktree at 2d58dd7 (unmodified vecs, PR #274's benchmark commit).
# scratch: worktree on local branch scratch/fork-adapter at 2d58dd7 + perf/adapter/*.patch.
# Both get their own node_modules: symlinks to <vecs-clone>/node_modules/* except
#   @vworlds/<workspace> -> <target>/<same path>  (workspace links must point into the checkout)
#   box2d3-wasm          -> $PKG_ROOT/<target name> (switch builds with perf/use-build.sh)
# <vecs-clone> must have run `npm ci`. Builds the checkout's packages at the end.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VECS="$(realpath "$1")"
TARGET="$(realpath -m "$2")"
MODE="$3"
BASE=2d58dd7
PKG_ROOT="${PKG_ROOT:-/home/user/pkg}"
NAME="$(basename "$TARGET")"

git -C "$VECS" fetch -q origin perf/273-pose-out-bulk-read 2>/dev/null || true
case "$MODE" in
  stock) git -C "$VECS" worktree add --detach "$TARGET" "$BASE" ;;
  scratch)
    git -C "$VECS" worktree add -b "scratch/fork-adapter-$NAME" "$TARGET" "$BASE"
    git -C "$TARGET" -c user.email=scratch@local -c user.name=scratch am -q "$ROOT"/perf/adapter/*.patch
    ;;
  *) echo "mode must be stock or scratch" >&2; exit 2 ;;
esac

mkdir -p "$TARGET/node_modules/@vworlds"
for entry in "$VECS"/node_modules/* "$VECS"/node_modules/.bin; do
  name="$(basename "$entry")"
  [[ "$name" == "@vworlds" || "$name" == "box2d3-wasm" ]] && continue
  ln -sfn "$entry" "$TARGET/node_modules/$name"
done
for entry in "$VECS"/node_modules/@*; do
  name="$(basename "$entry")"
  [[ "$name" == "@vworlds" ]] && continue
  ln -sfn "$entry" "$TARGET/node_modules/$name"
done
for entry in "$VECS"/node_modules/@vworlds/*; do
  name="$(basename "$entry")"
  if [[ -L "$entry" ]]; then
    rel="$(realpath --relative-to="$VECS" "$(readlink -f "$entry")")"
    ln -sfn "$TARGET/$rel" "$TARGET/node_modules/@vworlds/$name"
  else
    ln -sfn "$entry" "$TARGET/node_modules/@vworlds/$name"
  fi
done
mkdir -p "$PKG_ROOT/$NAME/build/dist"
cp "$ROOT/box2d3-wasm/package.json" "$PKG_ROOT/$NAME/"
ln -sfn "$PKG_ROOT/$NAME" "$TARGET/node_modules/box2d3-wasm"
echo "created $TARGET ($MODE); point it at a build with: PKG_ROOT=$PKG_ROOT perf/use-build.sh $NAME <build-dir>"

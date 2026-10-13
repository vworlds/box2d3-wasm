#!/usr/bin/env bash
# Run scripts/build.sh inside the build image (emsdk 4.0.18, Node 24, TypeScript 5).
#
#   scripts/build-in-docker.sh                       # deluxe + compat, Release
#   FLAVOURS=deluxe scripts/build-in-docker.sh
#
# Builds the image from scripts/Dockerfile if it is missing (set REBUILD_IMAGE=1 to force). The
# container runs as root, so the repository is chowned back to the invoking user afterwards.
# Environment passed through: FLAVOURS, TARGET_TYPE. MOUNT sets where the repository appears
# inside the container (default /w); the output must not depend on it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${B2_BUILD_IMAGE:-b2wasm-build:4.0.18}"
MOUNT="${MOUNT:-/w}"

if [[ "${REBUILD_IMAGE:-0}" == 1 ]] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -t "$IMAGE" -f "$ROOT/scripts/Dockerfile" "$ROOT/scripts"
fi

docker run --rm \
  -v "$ROOT:$MOUNT" -w "$MOUNT" \
  -e FLAVOURS="${FLAVOURS:-deluxe compat}" \
  -e TARGET_TYPE="${TARGET_TYPE:-Release}" \
  -e OWNER="$(id -u):$(id -g)" \
  "$IMAGE" bash -c '
    source /opt/emsdk/emsdk_env.sh >/dev/null
    git submodule update --init box2d
    rc=0
    scripts/build.sh || rc=$?
    chown -R "$OWNER" .
    exit $rc'

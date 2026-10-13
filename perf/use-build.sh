#!/usr/bin/env bash
# use-build.sh <checkout-name> <build-dir>: point that checkout's box2d3-wasm package at a build.
# Expects /home/user/pkg/<checkout-name>/{package.json,build/dist} (see CHECKPOINT.md, Phase 3 setup)
# and <checkout>/node_modules/box2d3-wasm -> /home/user/pkg/<checkout-name>.
set -e
ln -sfn "$(realpath "$2")" "/home/user/pkg/$1/build/dist/es"
echo "$1 -> $(readlink /home/user/pkg/$1/build/dist/es)"

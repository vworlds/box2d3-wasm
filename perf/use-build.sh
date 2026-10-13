#!/usr/bin/env bash
# use-build.sh <checkout-name> <build-dir>: point that checkout's box2d3-wasm package at a build.
# Expects $PKG_ROOT/<checkout-name>/{package.json,build/dist} and
# <checkout>/node_modules/box2d3-wasm -> $PKG_ROOT/<checkout-name> (perf/setup-vecs-checkout.sh).
set -e
PKG_ROOT="${PKG_ROOT:-/home/user/pkg}"
ln -sfn "$(realpath "$2")" "$PKG_ROOT/$1/build/dist/es"
echo "$1 -> $(readlink "$PKG_ROOT/$1/build/dist/es")"

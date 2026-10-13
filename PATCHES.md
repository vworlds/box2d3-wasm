# Patches against upstream

This page lists what `vworlds/box2d3-wasm` changes relative to upstream, and how to carry those
changes onto a newer upstream.

| component | upstream base |
|---|---|
| box2d3-wasm | [Birch-san/box2d3-wasm](https://github.com/Birch-san/box2d3-wasm) **5.2.0**, commit `ee2a63b` |
| Box2D (submodule `box2d`) | [erincatto/box2d](https://github.com/erincatto/box2d) `3a4f0da` (unchanged pin) |
| box2cpp, enkiTS (submodules) | unchanged pins |
| toolchain | emsdk **4.0.18** (as upstream CI); TypeScript 5 for `emcc --emit-tsd` |

## What ships (inside `box2d3-wasm/`, the npm package)

`git diff --stat ee2a63b HEAD -- box2d3-wasm` covers 1,500 added lines in 11 files, 7 of them new.
Existing upstream files change in only three places.

| file | status | purpose |
|---|---|---|
| `csrc/fastpath.cpp` | new | the hand-written `b2x_` exports: packed ids, layout JSON from `sizeof`/`offsetof`, step, bulk move export, event spans, user data, profile-timer switch, composites |
| `csrc/fastpath_body.gen.cpp` | new, generated | `b2x_Body_*` wrappers for 60 of the 65 `b2Body_*` functions |
| `tools/gen_fastpath.py` | new | generates the file above and `src/fastpath_body.gen.d.ts` from `box2d.h`; `--check` detects stale output |
| `src/fastpath.mjs`, `src/fastpath.d.ts`, `src/fastpath_body.gen.d.ts` | new | the `box2d3-wasm/fastpath` helper and its types |
| `patches/box2d/0001-runtime-switch-for-profile-timers.patch`, `patches/README.md` | new | the only change to Box2D's C sources (below) |
| `docs/fastpath.md`, `docs/examples/fastpath-example.ts` | new | API reference and a typechecked example (not in the npm tarball) |
| `shell/0_build_makefile.sh` | modified | applies `patches/box2d/*.patch` idempotently; compiles the Box2D library with `-flto` for Release; optional `EXTRA_CFLAGS` |
| `shell/1_build_wasm.sh` | modified | compiles the two fast-path sources; exports `HEAP32`, `HEAPF32`, `wasmMemory`; optional `EXTRA_EMCC_OPTS`; copies the helper into `build/dist/es/` |
| `package.json`, `package-lock.json` | modified | name `@vworlds/box2d3-wasm`, version `5.2.0-vworlds.1`, export `./fastpath`, `publishConfig.access: public` |

The embind glue (`csrc/glue.cpp`, `threading.cpp`, `debugDraw.cpp`), the awk post-processing, the
`.d.ts` template and `entry.mjs` are untouched. The embind API is byte-for-byte upstream's.

### The Box2D patch

`patches/box2d/0001-runtime-switch-for-profile-timers.patch` (≈20 lines in `src/timer.c`, the
`__linux__ || __EMSCRIPTEN__` branch, guarded by `#if defined(__EMSCRIPTEN__)`) adds
`b2SetProfileTimers(bool)` / `b2GetProfileTimers()`. When off, `b2GetTicks` returns 0 and
`b2GetMilliseconds` / `b2GetMillisecondsAndReset` return 0 without reading the clock. Default is
on. All 44 call sites of these functions write `world->profile` or the `B2_SNOOP_TOI_COUNTERS`
statistics, so results are unaffected; only `b2World_GetProfile` changes (zeros while off). The
build applies it with `git -C box2d apply`. Afterwards the submodule shows as modified, which is
expected; `git -C box2d checkout .` undoes it, and the next build re-applies it.

## What does not ship

`perf/` (benchmarks, proof kit, tests, results, the local vecs scratch adapter as patches),
`CHECKPOINT.md`, `REPORT.md`, `PATCHES.md`: repository-only.

## Rebasing onto a newer upstream

1. **box2d3-wasm.** Merge or rebase onto the new upstream tag. Conflicts can only occur in
   `shell/0_build_makefile.sh`, `shell/1_build_wasm.sh` and `package.json`. Each fork hunk is a
   self-contained block with a comment saying why it is there.
2. **Box2D submodule moved?**
   - `git -C box2d apply --check "$PWD/box2d3-wasm/patches/box2d/0001-runtime-switch-for-profile-timers.patch"`.
     If it no longer applies, re-create it: the change is "return 0 early from the three timer
     functions when the switch is off".
   - `python3 box2d3-wasm/tools/gen_fastpath.py`, then review the generated diff and its
     skipped list. New `b2Body_*` functions are picked up automatically; an unknown argument type
     makes the generator skip the function and list it.
   - Build. `fastpath.cpp`'s `static_assert`s fail at compile time if a field the fast path
     exposes stops being 4-byte aligned, or if `b2ShapeId` / `b2JointId` stop being the
     `(index1, rev)` word pair. A changed `b2BodyMoveEvent` / event struct is picked up by the
     layout JSON. Bump `B2X_VERSION` if a fast-path record or signature changes.
3. **Prove.**
   - If Box2D changed, regenerate the reference checksums first. Run `perf/bench/vecs-tick.ts` for
     every scene with the new *stock* build and unmodified vecs, and update `REF` in
     `perf/prove.sh`.
   - Then `perf/prove.sh <build>`: the differential test on both flavours, the checksums with
     the scratch adapter and with unmodified vecs, and the vecs suites in both checkouts.

## Producing a patch series

```bash
git diff ee2a63b HEAD -- box2d3-wasm > fork-vs-upstream-5.2.0.diff                 # everything that ships
git format-patch ee2a63b..HEAD -- box2d3-wasm -o /tmp/series                       # per commit
```

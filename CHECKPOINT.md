# CHECKPOINT: box2d3-wasm fork for a cheaper vecs physics tick

Fork: `vworlds/box2d3-wasm`, branch `claude/youthful-edison-uyuukr`, based on upstream
box2d3-wasm **5.2.0** (`ee2a63b`). Reference consumer: `vworlds/vecs` (read-only; issue #273, PR #274).

## Status

| Phase | State |
| --- | --- |
| 1. Setup and baseline | **done** (BREAKPOINT A) |
| 2. Plan and API design | not started |
| 3. Iterate | not started |
| 4. Final analysis | not started |

Hard rule for every later phase: results stay bit-identical to stock 5.2.0. Proof per build: the
five checksums below, plus vecs's real-WASM suites (`motion_accuracy.test.ts` among them).

---

## Phase 1 results

### 1.1 Stock build is byte-identical to the published package

- Toolchain: emsdk **4.0.18** (as in `.github/workflows`), Node 24.15.0 for running. emcc's
  `--emit-tsd` breaks with TypeScript 6 (`TS5101 outFile deprecated`), so put TypeScript **5.9**
  first on `PATH` when building (CI got TS 5 from `npm i -g typescript` at the time).
- Built `FLAVOUR=deluxe` and `compat`, `TARGET_TYPE=Release`, with the repo's own scripts.
- Built in `/home/user/...`, the `.mjs` and `.d.ts` are byte-identical to npm `box2d3-wasm@5.2.0`.
  The `.wasm` differs only in embedded `__FILE__`/include path strings (`/home/runner/work/...`
  vs. the local path), so ~100 bytes of data.
- Rebuilt under CI's exact paths (`/home/runner/work/box2d3-wasm/box2d3-wasm` and
  `EM_CACHE=/home/runner/work/_temp/281a1663-ccee-4526-a311-3d27de0b31ad/emsdk-main/upstream/emscripten/cache`):
  **`Box2D.deluxe.wasm`, `Box2D.compat.wasm`, `Box2D.deluxe.mjs`, `Box2D.compat.mjs` are all
  byte-identical (`cmp`) to the npm package.** The build is reproducible; our stock baseline is the
  published artifact.
- In Node, `entry.mjs` loads the **deluxe** flavour (SIMD + pthreads); vecs creates worlds with the
  default `workerCount` (1), so the step runs single-threaded.
- The checksums of the stock build from source equal those of the npm package in all five scenes
  (table below).

### 1.2 Baseline (stock 5.2.0, vecs at `2d58dd7` = PR #274's benchmark commit with unmodified vecs code)

Harness: `perf/bench/vecs-tick.ts` (one scene per fresh process). `drift500` / `drift2000` are
exactly vecs's `bench/physics-pose-out.ts` scene and reproduce its checksums `11c76fa7` /
`a66a94ee`. Added scenes:

- `drift10000`: same scene, 10,000 bodies (300 warmup + 300 measured steps).
- `contact`: 1,000 dynamic circles/boxes piled in a static box under gravity, sleep disabled, a
  kinematic paddle stirring the pile; ContactEvents on 1/4, HitEvents on 1/8, Detectable on 1/2 of
  the shapes plus one sensor strip. Per step ≈ 26 contact begins, 26 ends, 11 hits, 1.2 sensor
  events. Checksum hashes final poses and velocities **plus every event (other entity, hit point,
  normal, speed) of every measured step**: `5db7f953`.
- `worlds25x19`: 25 independent vecs worlds × 19 drifting bodies (Space Rocks shape):
  `a8a0671e`.

All bodies carry Position, Rotation, LinearVelocity and AngularVelocity. 30 Hz, 4 substeps.
Timings are **ns per body per step**: copy-out = `PhysicsPoseSyncOut` system, step =
`PhysicsStep` system, whole tick = `world.progress` of all worlds. Medians of 10 fresh-process runs
(5 rounds alternating the npm package and the from-source build, ABBA order, scenes rotated):

| scene | bodies | copy-out | step | events | whole tick | noise (tick max/min) | A/A npm vs src | alloc / step | alloc / body / step | checksum |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| drift500 | 500 | 4862 | 203 | 30 | 5130 | 35% | +1.0% | 1.89 MB | 3782 B | 11c76fa7 |
| drift2000 | 2000 | 5337 | 175 | 12 | 5532 | 13% | -1.2% | 7.50 MB | 3751 B | a66a94ee |
| drift10000 | 10000 | 5551 | 226 | 5 | 5787 | 40% | +5.4% | 37.76 MB | 3776 B | 70623967 |
| contact | 1000 | 5887 | 1692 | 240 | 7813 | 25% | -3.5% | 4.27 MB | 4274 B | 5db7f953 |
| worlds25x19 | 475 | 5162 | 840 | 195 | 6751 | 20% | +6.0% | 2.10 MB | 4429 B | a8a0671e |

Noise: this is a shared 4-vCPU VM. Single runs of the same build vary 13–40% (max/min), and the
A/A medians of two identical builds differ by up to 6%. Only differences well above ~10% are
meaningful from a single round; later comparisons use ≥5 alternating rounds and medians.
Allocation is deterministic (identical across rounds): bytes of JS heap growth per step over a
GC-free window (`BENCH_MODE=alloc`, 1 GB semi-space, separate runs because that flag distorts timing).

Raw data: `perf/results/phase1-baseline.{jsonl,txt}`, `perf/results/phase1-alloc.{jsonl,txt}`.

### 1.3 CPU profile: where the tick goes

Profiled with `node --cpu-prof --cpu-prof-interval 250` against a stock build linked with
`--profiling-funcs` (wasm function names). That build has the same 1,321 functions, the same
`.mjs` apart from minified import names, and the same checksums; binaryen orders types and
functions differently, so it is used for attribution only. Only samples under the measured tick
loop count. Categories: **embind-js** = JS glue in `Box2D.deluxe.mjs`; **embind-wasm** = C++
binding thunks in wasm; **wasm-alloc** = malloc/free + the allocator's pthread mutex (embind's
temporaries); **box2d** = Box2D's own C code; **vecs-physics** = the adapter; **vecs** = ECS core.

Self time, share of the whole tick:

| category | drift500 | drift2000 | drift10000 | contact | worlds25x19 |
|---|---:|---:|---:|---:|---:|
| embind-js | 60.8% | 60.3% | 58.4% | 45.0% | 54.8% |
| embind-wasm | 6.3% | 4.9% | 5.9% | 4.0% | 5.5% |
| wasm-alloc | 5.3% | 4.9% | 5.0% | 3.7% | 4.1% |
| **embind / marshalling total** | **72.4%** | **70.1%** | **69.3%** | **52.7%** | **64.4%** |
| box2d | 5.4% | 4.4% | 5.4% | 22.4% | 5.7% |
| vecs-physics | 8.1% | 7.8% | 9.6% | 8.5% | 8.8% |
| vecs | 11.9% | 15.9% | 13.9% | 14.9% | 15.9% |
| engine (V8 internals) + harness | 2.3% | 1.8% | 1.8% | 1.5% | 5.2% |

By system:

| system / category | drift500 | drift2000 | drift10000 | contact | worlds25x19 |
|---|---:|---:|---:|---:|---:|
| **PhysicsPoseSyncOut** | **87.9%** | **86.2%** | **90.3%** | **63.9%** | **71.6%** |
| &nbsp;&nbsp;embind-js + embind-wasm + wasm-alloc | 71.6% | 69.8% | 69.1% | 50.8% | 57.9% |
| &nbsp;&nbsp;vecs-physics (loop, compares) | 7.8% | 7.7% | 9.6% | 7.1% | 6.0% |
| &nbsp;&nbsp;vecs (`entity.get`, `entity.set` enqueue) | 5.1% | 5.7% | 8.2% | 3.6% | 5.5% |
| &nbsp;&nbsp;box2d (`b2Atan2`, velocity getters) | 1.7% | 1.4% | 1.7% | 1.1% | 1.1% |
| **PhysicsStep** | **4.4%** | **3.2%** | **3.8%** | **21.8%** | **12.7%** |
| &nbsp;&nbsp;box2d | 3.6% | 3.0% | 3.8% | 21.4% | 4.6% |
| &nbsp;&nbsp;embind + `b2GetTicks`→`performance.now` (engine) | 0.7% | 0.2% | 0.0% | 0.4% | 8.0% |
| **PhysicsEvents** | **0.4%** | **0.2%** | **0.1%** | **3.2%** | **2.7%** |
| **other** (deferred flush, empty systems: vecs) | **7.3%** | **10.4%** | **5.9%** | **11.2%** | **13.0%** |

Top self-time functions (drift2000; the others are in `perf/results/profiles/stock-*.txt`):

| share | function | what it is |
|---:|---|---|
| 43.5% | `makeClassHandle` (embind) | builds every class handle with `Object.create(proto, {$$: {value, writable}})`, V8's slow descriptor path, plus a `count: {value: 1}` box |
| 7.1% | `_executeCommand` (vecs) | deferred `entity.set` flush |
| 5.7% | `get` (embind property getter) | `move.transform`, `.p`, `.q`, `.x`… |
| 4.5% | `RegisteredPointer_fromWireType` (embind) | wraps returned pointers into handles |
| 4.5% | `get` (vecs `entity.get`) | four pose components per body |
| 4.2% + 3.5% | `writePose`, pose-out loop (vecs-physics) | compares and writes |
| 2.6% | `toWireType` (embind value_object) | marshalling `bodyId` / `worldId` arguments (`for…in` over fields) |
| 2.0% | `validateThis` (embind) | `this` check on every method/getter |
| 3.2% | `pthread_mutex_lock` + `malloc` (wasm) | value_object temporaries and by-value returns |

Profile findings that drive Phase 2:

1. **Handle creation dominates.** About 6 handles per body per step (`GetMoveEvent`, `.transform`,
   `.p`, `.q`, `b2Body_GetLinearVelocity`, plus `.bodyId` as a value-object read). Each costs
   ~420–460 ns, and most of the **~3.8 KB allocated per body per step** comes from them.
2. **value_object marshalling.** Every `b2BodyId` / `b2WorldId` argument costs a wasm `malloc`,
   one wasm call per field, and a `free` (`toWireType` + `rawConstructor` + setters + destructor);
   every returned id costs a getter call per field plus a `free`. A scalar `bodyId` call
   (`b2Body_GetAngularVelocity`) costs ~130 ns, almost all marshalling.
3. **Box2D itself is small.** On no-contact scenes the step is 3–4% of the tick. On the contact
   scene it is 21%, and it is the only cost that must remain.
4. **Many small worlds pay fixed per-world costs:** the `b2World_Step` crossing, ~2.0 µs per call on
   an empty world. That includes Box2D's `b2GetTicks` profiling timers, which call out to JS
   `clock_time_get` → `performance.now()` several times per step (≈ 4% of the worlds25x19 tick;
   timing-only, never feeds results). Also the event headers, and vecs running empty systems
   (13% "other").
5. **vecs itself (~12–16%)**, mostly the deferred `entity.set` flush and `entity.get`. A fork cannot
   remove that cost, but the adapter's design decides how much of it is paid (e.g. no `set`
   for unchanged values, which vecs already does).

### 1.4 Every Box2D call vecs makes per step, with its marshalling cost

Per-op prices from `perf/bench/embind-ops.mjs` (stock, 2,000-body world; two runs agree to ~5%).
"handle" means an embind class handle: JS object + `$$` record + wasm-side copy for by-value.

**Every step, per world (fixed):**

| site | call | marshalling | ns / call |
|---|---|---|---:|
| `core/step.ts` | `b2World_Step(worldId, dt, subSteps)` | worldId value_object (malloc + 2 setters + free); includes Box2D's fixed per-step work and `b2GetTicks` JS calls | 1,990 (empty world) |
| `body/pose_out.ts` | `b2World_GetBodyEvents(worldId)` → handle, `.delete()` | worldId marshal + by-value struct copy + handle | 564 |
| | `bodyEvents.moveCount` | getter + `validateThis` | 31 |
| `events/publish.ts` | `b2World_GetContactEvents(worldId)` + 3 counts + delete | as above | 731 |
| | `b2World_GetSensorEvents(worldId)` + 2 counts + delete | as above | 680 |

**Every step, per moved body** (`PhysicsPoseSyncOut`; all awake bodies are in the move events):

| call | marshalling | ns |
|---|---|---:|
| `bodyEvents.GetMoveEvent(i)` + `move.delete()` | by-value copy (malloc) + handle | 461 |
| `move.bodyId` | value_object read: 3 getter calls + free + JS object | 143 |
| `move.transform` | reference handle | 418 |
| `transform.p` | reference handle | 414 |
| `transform.q` | reference handle | 444 |
| `p.x`, `p.y` | 2 float getters | 2 × 33 |
| `q.GetAngle()` | method → `b2Rot_GetAngle` (`b2Atan2`) | 23 |
| `b2Body_GetLinearVelocity(bodyId)` + `.x/.y` + delete (if LinearVelocity present) | bodyId marshal + by-value b2Vec2 + handle | 747 |
| `b2Body_GetAngularVelocity(bodyId)` (if AngularVelocity present) | bodyId marshal | 132 |
| **sum of crossings, fully populated body** | about 6 handles, 2 bodyId marshals | **≈ 2,850** |

The measured copy-out is ~4,900–5,600 ns per body. The rest is GC of the ~3.8 KB, the vecs
`get`/`set` calls and the loop.

**Every step, per event** (`PhysicsEvents`; only shapes with opt-in components emit):

| call | marshalling |
|---|---|
| `GetBeginEvent(i)` + delete | handle (class_) + `shapeIdA`, `shapeIdB` value_object reads (~145 ns each) |
| `GetEndEvent(i)` | value_object (by value; 2 nested shapeIds) |
| `GetHitEvent(i)` + delete | handle + 2 shapeId reads + `point`, `normal` reference handles (~420 ns each) + 5 float getters |
| sensor `GetBeginEvent(i)` / `GetEndEvent(i)` | value_object with 2 nested shapeIds |

Also, `PhysicsEvents` allocates three `Set`s per step (vecs-side).

**Only when something changes (not per step in steady state):**

| site | call | ns |
|---|---|---:|
| `body/pose_in.ts` (user writes Position / Rotation) | `b2Body_GetRotation`/`GetPosition` (handle) + `b2MakeRot` (handle) + `vec.Set` + `b2Body_SetTransform` | ≈ 1,500–2,000 |
| `body/pose_in.ts` (user writes velocities) | `vec.Set` (400: it returns a handle) + `b2Body_SetLinearVelocity`; `b2Body_SetAngularVelocity` | 1,430; 243 |
| `forces/gather.ts` (per entity with non-zero Force/Torque, every step while set) | `vec.Set` + `b2Body_ApplyForceToCenter`; `b2Body_ApplyTorque` | 588; ~130 |
| `forces/impulses.ts` (per impulse) | `vec.Set` + `b2Body_ApplyLinearImpulseToCenter`; `b2Body_ApplyAngularImpulse` | ~590; ~130 |
| `kinematic/targets.ts` (per kinematic body with a target, every step) | `b2Body_GetType` + `GetPosition` (handle) + `GetRotation` (handle) + `GetAngle` + `SetLinearVelocity` + `SetAngularVelocity` (+`SetAwake`) | ≈ 3,000 |
| `body/mass.ts` (dirty bodies only) | `ApplyMassFromShapes`, `GetMassData` (handle), `ComputeAABB` (handle), `SetMassData` | rare |
| `core/reaper.ts`, `*/lifecycle.ts` | create/destroy bodies, shapes, joints | rare |
| `vecs-phaser-server/dead_reckoned.ts` per DR entity | `isAwake` → `b2Body_IsAwake` when the pose is unchanged; at baseline writes `bodyMotion` → `IsAwake`, `GetLinearVelocity` (handle), `GetAngularVelocity`, `GetLinearDamping`, `GetAngularDamping`, `GetLocalCenterOfMass` (handle), `GetMass`, `GetGravityScale` | 125; ≈ 2,400 per baseline |

---

## Decisions so far

- Baseline vecs = commit `2d58dd7` of vecs `perf/273-pose-out-bulk-read` (the PR's benchmark on
  unmodified vecs code). The PR's `c61c2f0` supported-API tweak is not the baseline.
- Timing runs use default V8 flags. Allocation is measured in separate runs.
- The harness lives in the fork under `perf/` (not published: the npm package is `box2d3-wasm/`).
- `shell/1_build_wasm.sh` gained an `EXTRA_EMCC_OPTS` hook. With it empty the output is
  byte-identical (verified with `cmp`).

## Next steps (Phase 2, after go-ahead)

Design the data API from the table above. Candidates already visible, in expected order of gain:

1. Bulk move export (pointer + count + generated layout, or copy into a caller-owned typed array
   in one crossing) carrying the body's integer user data, the angle already computed by
   `b2Rot_GetAngle` in wasm, and optionally linear/angular velocity. This removes ~6 handles and
   2 marshals per body.
2. Raw (non-embind) exports for per-step calls: ids passed as packed integers, so no value_object
   marshalling.
3. "Step and export" in one call. Batch many worlds in one crossing.
4. Contact/sensor/hit events as flat arrays.
5. Scalar/out-param body getters and setters for the change-driven paths.
6. Fixed per-world costs: `b2GetTicks` timer calls (timing-only) and the empty-world step crossing.
7. A faster embind `makeClassHandle` for the legacy API (helps every unmigrated call site).
8. Then build variants (allocator, `-O3`/LTO flags, SIMD), each gated on identical checksums.

---

## How to rebuild and re-run everything from a clean checkout

```bash
# toolchain
git clone https://github.com/emscripten-core/emsdk.git /opt/emsdk
(cd /opt/emsdk && ./emsdk install 4.0.18 && ./emsdk activate 4.0.18)
mkdir -p /opt/ts5 && (cd /opt/ts5 && npm i typescript@5.9)          # emcc --emit-tsd needs TS 5
curl -sSfL https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz | tar -xJ -C /opt
export PATH=/opt/node-v24.15.0-linux-x64/bin:/opt/ts5/node_modules/.bin:$PATH
source /opt/emsdk/emsdk_env.sh

# fork
git clone -b claude/youthful-edison-uyuukr https://github.com/vworlds/box2d3-wasm && cd box2d3-wasm
git submodule update --init --recursive
(cd box2d3-wasm && npm ci)
perf/build-variant.sh ../builds/stock-src                 # Release deluxe -> ../builds/stock-src
FLAVOURS="deluxe compat" REBUILD_LIB=1 perf/build-variant.sh ../builds/stock-src   # both flavours
perf/build-variant.sh ../builds/stock-prof --profiling-funcs                       # profiling only

# byte-identical proof against npm: build under CI paths
#   copy the repo to /home/runner/work/box2d3-wasm/box2d3-wasm, set
#   EM_CACHE=/home/runner/work/_temp/281a1663-ccee-4526-a311-3d27de0b31ad/emsdk-main/upstream/emscripten/cache
#   build as above, then `cmp` each .wasm/.mjs with node_modules/box2d3-wasm/build/dist/es/...

# vecs consumer (local only, never pushed)
git clone https://github.com/vworlds/vecs ../vecs && cd ../vecs
git fetch origin perf/273-pose-out-bulk-read && git worktree add ../vecs-scratch 2d58dd7
npm ci && cd ../vecs-scratch && ln -s ../vecs/node_modules node_modules
for p in vecs vecs-wire vecs-protocol vecs-physics; do ln -sfn ../../../vecs/lib/$p/node_modules lib/$p/node_modules; done
npm run build -w @vworlds/vecs -w @vworlds/vecs-physics
cd ../box2d3-wasm

# one scene
BENCH_VECS_ROOT=../vecs-scratch BOX2D_ENTRY=../builds/stock-src/entry.mjs \
  node --import ./perf/bench/register.mjs perf/bench/vecs-tick.ts drift2000
# alternating rounds, all scenes (A/B any number of variants: name=<vecs root>@<entry.mjs>)
node perf/bench/run.mjs --rounds 5 --variant stock=../vecs-scratch@../builds/stock-src/entry.mjs \
  --variant fork=../vecs-scratch@../builds/fork/entry.mjs --out perf/results/x.jsonl
node perf/bench/run.mjs --alloc --rounds 2 --variant stock=../vecs-scratch@../builds/stock-src/entry.mjs
# profile + ranked table
BENCH_VECS_ROOT=../vecs-scratch BOX2D_ENTRY=../builds/stock-prof/entry.mjs node --cpu-prof \
  --cpu-prof-interval 250 --cpu-prof-dir=prof --import ./perf/bench/register.mjs perf/bench/vecs-tick.ts contact
node perf/bench/analyze-profile.mjs prof/<file>.cpuprofile --top 40
# per-op marshalling prices
BOX2D_ENTRY=../builds/stock-src/entry.mjs node perf/bench/embind-ops.mjs
```

Reference checksums (stock 5.2.0, default warmup/steps per scene): drift500 `11c76fa7`,
drift2000 `a66a94ee`, drift10000 `70623967`, contact `5db7f953`, worlds25x19 `a8a0671e`.

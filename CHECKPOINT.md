# CHECKPOINT: box2d3-wasm fork for a cheaper vecs physics tick

Fork: `vworlds/box2d3-wasm`, branch `claude/youthful-edison-uyuukr`, based on upstream
box2d3-wasm **5.2.0** (`ee2a63b`). Reference consumer: `vworlds/vecs` (read-only; issue #273, PR #274).

## Status

| Phase | State |
| --- | --- |
| 1. Setup and baseline | **done** (BREAKPOINT A) |
| 2. Plan and API design | **done** (BREAKPOINT B) |
| 3. Iterate | not started |
| 4. Final analysis | not started |

Hard rule for every later phase: results stay bit-identical to stock 5.2.0. Proof per build: the
seven scene checksums (five from Phase 1, two added in Phase 2), the fast-path differential test,
plus vecs's real-WASM suites (`motion_accuracy.test.ts` among them). See §2.5.

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

Self time, share of the whole tick (GC samples sit at the profile root, outside any JS stack;
those inside the tick loop's time window are counted as `gc` — corrected in Phase 2):

| category | drift500 | drift2000 | drift10000 | contact | worlds25x19 |
|---|---:|---:|---:|---:|---:|
| embind-js | 59.8% | 59.6% | 57.6% | 44.3% | 54.3% |
| embind-wasm | 6.2% | 4.8% | 5.8% | 4.0% | 5.5% |
| wasm-alloc | 5.2% | 4.8% | 4.9% | 3.7% | 4.0% |
| gc | 1.6% | 1.2% | 1.2% | 1.5% | 0.9% |
| **embind / marshalling / GC total** | **72.8%** | **70.4%** | **69.6%** | **53.4%** | **64.7%** |
| box2d | 5.3% | 4.4% | 5.3% | 22.1% | 5.6% |
| vecs-physics | 8.0% | 7.7% | 9.5% | 8.3% | 8.8% |
| vecs | 11.7% | 15.7% | 13.8% | 14.7% | 15.7% |
| engine (V8 internals) + harness | 2.2% | 1.8% | 1.8% | 1.5% | 5.2% |

Note on "copy-out": vecs runs every system inside `world.defer(...)` and drains the command queue
in `endDefer()`, so the deferred flush of pose-out's `entity.set` calls runs **inside**
`PhysicsPoseSyncOut._run`. The copy-out timer (and vecs's own benchmark number) therefore includes
the flush. The profile shows the flush under "other", because its frames are not under
`pose_out.js`.

By system (system totals include GC as its own row; the indented category rows come from the
first, GC-free pass and are within ±0.3 points):

| system / category | drift500 | drift2000 | drift10000 | contact | worlds25x19 |
|---|---:|---:|---:|---:|---:|
| **PhysicsPoseSyncOut** | **86.5%** | **85.2%** | **89.1%** | **62.9%** | **70.9%** |
| &nbsp;&nbsp;embind-js + embind-wasm + wasm-alloc | 71.6% | 69.8% | 69.1% | 50.8% | 57.9% |
| &nbsp;&nbsp;vecs-physics (loop, compares) | 7.8% | 7.7% | 9.6% | 7.1% | 6.0% |
| &nbsp;&nbsp;vecs (`entity.get`, `entity.set` enqueue) | 5.1% | 5.7% | 8.2% | 3.6% | 5.5% |
| &nbsp;&nbsp;box2d (`b2Atan2`, velocity getters) | 1.7% | 1.4% | 1.7% | 1.1% | 1.1% |
| **PhysicsStep** | **4.3%** | **3.2%** | **3.8%** | **21.5%** | **12.6%** |
| &nbsp;&nbsp;box2d | 3.6% | 3.0% | 3.8% | 21.4% | 4.6% |
| &nbsp;&nbsp;embind + `b2GetTicks`→`performance.now` (engine) | 0.7% | 0.2% | 0.0% | 0.4% | 8.0% |
| **PhysicsEvents** | **0.4%** | **0.2%** | **0.1%** | **3.1%** | **2.7%** |
| **other** (deferred flush, empty systems: vecs) | **7.2%** | **10.3%** | **5.8%** | **11.0%** | **12.8%** |
| **(garbage collector)** | **1.6%** | **1.2%** | **1.2%** | **1.5%** | **0.9%** |

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

## Decisions taken in Phase 1

- Baseline vecs = commit `2d58dd7` of vecs `perf/273-pose-out-bulk-read` (the PR's benchmark on
  unmodified vecs code). The PR's `c61c2f0` supported-API tweak is not the baseline.
- Timing runs use default V8 flags. Allocation is measured in separate runs.
- The harness lives in the fork under `perf/` (not published: the npm package is `box2d3-wasm/`).
- `shell/1_build_wasm.sh` gained an `EXTRA_EMCC_OPTS` hook. With it empty the output is
  byte-identical (verified with `cmp`).

---

## Phase 2: plan and API design

### 2.0 New evidence gathered for the design (measurement-only probes)

The probes live in `perf/spikes/` (`raw-crossing.mjs`, `step-fixed-cost.mjs`,
`ideal-reader.pose_out.js`). The ideal-reader probe replaces the compiled `pose_out.js` in a *copy*
of the built vecs (header comment says how). It uses a private embind pointer and `Math.atan2`, so
it is never shipped and its checksums differ from stock. Same-session numbers; the host drifted between sessions (stock drift2000 copy-out was
5,337 ns in Phase 1 and 8,202–8,419 ns during Phase 2), so only ratios within one alternating
session are compared.

| question | finding |
|---|---|
| Price of a raw (non-embind) wasm export call | **9 ns** (`_free(0)`), vs ~130 ns for an embind call taking a `bodyId` and ~420–460 ns for one returning a class handle. A typed-array read is a few ns. |
| What happens to views when memory grows? | Deluxe memory is a `SharedArrayBuffer`: after growth `Module.HEAPU8` is replaced (in the growing thread only), views created before growth **stay valid for their old range** (reads and writes hit the same memory), and new regions need a new view. Compat (non-shared) detaches the old buffer, so old views become length 0. `wasmMemory` is not exported today. |
| How fast can copy-out get if the data were free? | Ideal-reader probe: move events read straight from wasm memory (no handles, `Math.atan2` as a timing proxy for a wasm-computed angle). Copy-out **6,410 → 622 ns** (drift500, 10.3×) and **8,202 → 724 ns** (drift2000, 11.3×). Whole tick **6,723 → 909** (7.4×) and **8,502 → 927** (9.2×). 3 alternating rounds each. |
| What does the ideal path still allocate? | drift2000: **449 B/body/step**, all from vecs's `entity.set` (the `{x, y}` literal, the deferred command, update routing), because Position and Rotation change every step. rest2000 (no writes): 25 B/body/step, from V8 boxing fractional doubles passed to a non-inlined helper. That is avoidable with an in-place compare. |
| Why is a small-world step so expensive? | Profile of `b2World_Step` on 0- and 19-body worlds: **≈70% is Box2D's profiling timers**. `b2GetTicks` → `clock_gettime` → JS imports `_clock_time_get` / `_emscripten_get_now` → `performance.now()`, plus BigInt conversion and a heap-view check, many times per step (per stage, per substep). In the worlds25x19 tick this clock chain is **8.5%** (≈575 ns/body); in the single-world scenes 0.2–0.3%. |
| Do the timers ever affect results? | No. All 44 call sites write `world->profile.*` (`physics_world.c`, `solver.c`, `island.c`) or the `B2_SNOOP_TOI_COUNTERS` statistics (`distance.c`). |
| Box2D facts used by the design | Move events are written in `b2FinalizeBodiesTask` and already carry `body->userData`. Embind's `GetAngle` is `b2Atan2(s, c)`, i.e. `b2Rot_GetAngle`. The glue never touches body or shape `userData` (only callback contexts). vecs EIDs are safe integers from id pools (entities from 1000, recycled), so normally `< 2^32`. Box2D's `test_determinism.c` asserts an identical hash for 1–5 workers. |

Two scenes were added to the harness to make the read path and the force path measurable:

| scene (Phase 2 session, stock, 3 rounds × npm/src) | copy-out | step | forces | whole tick | alloc / body / step | checksum |
|---|---:|---:|---:|---:|---:|---|
| `rest2000`: 2,000 awake bodies at rest, sleep off; all in the move events every step, nothing changes | 6,498 | 139 | – | 6,681 | 3,306 B (no writes at all) | `17fc310b` |
| `drive500`: 500 drifting bodies with a constant Force and Torque | 6,973 | 576 | 1,484 | 9,157 | 4,877 B | `fd7cc876` |
| `drift2000` in the same session (host-speed reference) | 8,419 | 255 | – | 8,725 | 3,751 B | `a66a94ee` |

Noise in that session: 1–17% max/min. Raw data: `perf/results/phase2-extra-*`.

### 2.1 The fork's data API ("fast path", prefix `b2x_`)

All of it is **additive**: the embind API stays byte-for-byte as it is, so vecs can migrate one
call site at a time. The fast path is plain C exports (`EMSCRIPTEN_KEEPALIVE`) taking and
returning only `i32`/`f32`, called as `Module._b2x_*`. That costs ~9 ns per call with no
marshalling, no handle and no allocation. Every function calls the same public Box2D C function(s)
that the embind binding calls, with the same arguments, at the moment the caller chooses. That is
why its results are identical by construction (proof in §2.5).

**A. Ids.** Box2D ids are packed into 32-bit integers, so no value_object marshalling:

- world: `w = index1 | generation << 16` (both `uint16`);
- body, shape, chain, joint: two arguments `(index1, rev)` with `rev = world0 | generation << 16`;
- JS helpers `fp.world(worldId)`, `fp.rev(id)` convert the embind id objects vecs already holds.
  The adapter stores `index1`/`rev` next to `Body._bodyId` once, at creation.

**B. Layout descriptor, never handwritten.** `const char* b2x_GetLayout(void)` returns a JSON
string built once from an X-macro list of `sizeof` / `offsetof` expressions. It covers every
struct the fast path exposes: the export record, Box2D's own `b2BodyMoveEvent`,
`b2ContactBeginTouchEvent`, `b2ContactEndTouchEvent`, `b2ContactHitEvent`,
`b2SensorBeginTouchEvent`, `b2SensorEndTouchEvent`, the span headers, the motion and pose
out-structs. It also carries a `version`. A `static_assert` requires every exposed field to be
4-byte aligned, so JS can address fields as `base + offset/4` in `Float32Array`/`Int32Array`
views. JS parses the layout once at preload; nothing else in JS hardcodes an offset.

**C. Bulk move export, the copy-out replacement.**

```c
typedef struct b2xMove {   // 48 bytes; real offsets come from b2x_GetLayout()
  int32_t  bodyIndex;      // bodyId.index1
  uint32_t rev;            // bodyId.world0 | bodyId.generation << 16
  uint32_t userData;       // (uint32_t)(uintptr_t) body user data (see E)
  uint32_t flags;          // bit0 fellAsleep, bits1-2 b2BodyType, bit3 body valid
  float x, y;              // transform.p
  float c, s;              // transform.q
  float angle;             // b2Rot_GetAngle(q): the same b2Atan2(s, c) embind's GetAngle runs
  float vx, vy, w;         // b2Body_GetLinearVelocity / b2Body_GetAngularVelocity (flag)
} b2xMove;

int b2x_World_GetMoveCount(int world);
int b2x_World_ExportMoves(int world, b2xMove* out, int capacity, int flags);
//   flags: B2X_EXPORT_VELOCITY (1), B2X_EXPORT_DYNAMIC_ONLY (2)
//   Writes one record per move event, in Box2D's event order (the order vecs iterates today).
//   Returns the number of records; if it exceeds `capacity`, only `capacity` were written and
//   the caller grows its buffer and calls again (events stay valid until the next step).
void b2x_World_GetMoveEventSpan(int world, b2xSpan* out);   // zero-copy b2BodyMoveEvent[]
```

The buffer is caller-owned wasm memory: the adapter `_malloc`s it once, grows it rarely, and
reads it through whole-memory typed views. In one crossing per world per step, JS gets the
position, angle, both velocities, the body index and the user data of every moved body, with
zero allocations. `B2X_EXPORT_VELOCITY` reads velocities with the same public getters vecs calls
today, at the same simulation moment (after the step, before any other mutation).

**D. Step and event spans.**

```c
void b2x_World_Step(int world, float dt, int subSteps);
int  b2x_World_StepAndExportMoves(int world, float dt, int subSteps,
                                  b2xMove* out, int capacity, int flags);   // fused variant
typedef struct b2xSpan { uint32_t ptr; int32_t count; } b2xSpan;
typedef struct b2xContactSpans { b2xSpan begin, end, hit; } b2xContactSpans;
typedef struct b2xSensorSpans  { b2xSpan begin, end; } b2xSensorSpans;
void b2x_World_GetContactSpans(int world, b2xContactSpans* out);
void b2x_World_GetSensorSpans(int world, b2xSensorSpans* out);
```

Contact, sensor and hit events need no copy. The spans point into Box2D's own event arrays
(valid until the next step or world mutation), and JS reads `shapeIdA.index1`, `point.x`,
`approachSpeed`… at layout offsets. One crossing replaces the header handle, three count getters
and a handle (or value object) per event.

**E. Integer user data.** `b2x_Body_SetUserData(i, r, u32)` / `b2x_Shape_SetUserData(i, r, u32)`
store an integer in Box2D's existing `void* userData`; move records carry it (Box2D copies it into
every move event). vecs can store the EID there and skip its reverse map when `eid < 2^32`, falling
back to `bodyIndex` otherwise. This is optional: the reverse `ArrayMap` lookup costs ~3.5 ns.

**F. Scalar / out-parameter variants of every per-body getter and setter.** These are
**generated** from `box2d.h` by `tools/gen_fastpath.py`, for all 65 `b2Body_*` functions.
Scalars pass and return as-is. `b2Vec2`/`b2Rot`/`b2Transform`/`b2AABB`/`b2MassData` arguments
are flattened to floats, and returns go to a caller out-pointer. Id arrays (`GetShapes`,
`GetJoints`) become packed `(index1, rev)` pairs, and names and contact data are skipped. The
TypeScript declarations are generated in the same pass. A few hand-written composites each
reproduce, in one crossing, an exact call sequence vecs makes today:

| composite | equivalent to (today, in vecs) |
|---|---|
| `b2x_Body_SetPosition(i, r, x, y)` | `b2Body_SetTransform(id, {x, y}, b2Body_GetRotation(id))` (pose-in Position) |
| `b2x_Body_SetAngle(i, r, angle)` | `b2Body_SetTransform(id, b2Body_GetPosition(id), b2MakeRot(angle))` (pose-in Rotation) |
| `b2x_Body_GetPose(i, r, out)` | position, rotation and `b2Rot_GetAngle` (kinematic targets) |
| `b2x_Body_GetMotion(i, r, out)` | the 8 getters of `physics(world).bodyMotion` (dead reckoning) |

Float arguments cross the boundary as `f32`, which rounds exactly as embind's float conversion
does (round to nearest even from the JS double). So `vec.Set(x, y)` + `SetLinearVelocity` and
`b2x_Body_SetLinearVelocity(i, r, x, y)` hand Box2D the same bits.

**G. Exported memory and the growth rule.** The build exports `wasmMemory` (plus `HEAPF32` /
`HEAP32`). The rule, documented in the API reference:

1. *Calls that may grow memory:* creating or destroying worlds, bodies, shapes, joints and
   chains; `b2World_Step` / `b2x_World_Step` (contact, pair and island arrays grow); any embind
   call that returns a class by value or marshals a value_object; `_malloc`.
2. *Calls that never grow memory:* every `b2x_Body_*` / `b2x_Shape_*` getter and setter,
   `b2x_World_ExportMoves` into a caller buffer, `b2x_World_GetMoveCount`, `b2x_World_Get*Spans`,
   `b2x_GetLayout` after the first call.
3. *JS:* keep whole-memory views; after a call from list 1 and before reading memory, call
   `fp.sync()`. It compares `memory.buffer` with the views' buffer and rebuilds them on change
   (deluxe: a new `SharedArrayBuffer` object after growth; compat: the old buffer is detached).
   One check per step costs ~40 ns.

**H. JS helper `box2d3-wasm/fastpath`** (new package export with `.d.ts`):
`createFastPath(module)` returns `{ layout, memory, f32, i32, u32, sync(), world(id), rev(id),
alloc(bytes), free(ptr) }`, plus a small move-exporter that owns a growable record buffer. The
helper has no per-call allocation. The vecs hot loop reads `fp.f32` / `fp.i32` directly.

**I. Profile-timer switch.** A ~20-line patch to `box2d/src/timer.c` (emscripten branch), kept as
`box2d3-wasm/patches/box2d/0001-runtime-switch-for-profile-timers.patch` and applied idempotently
by `shell/0_build_makefile.sh`. It adds `b2SetProfileTimers(bool)`, exported as
`b2x_SetProfileTimers(int)`. When off, `b2GetTicks` returns 0 and `b2GetMilliseconds*` return 0
without reading the clock, so `b2World_GetProfile` reports zeros. The default stays **on**
(stock behavior); vecs turns it off at preload. It is the only patch to Box2D's C sources.

**J. Many small worlds.** `b2x_Worlds_Step(const int32_t* worlds, int n, float dt, int subSteps)`
and a matching batched export would save `n−1` crossings (~10 ns each) per call type per tick, at
most ~2 ns/body. Using them would also force vecs to step every world inside one world's phase,
reordering phases. So this is **deferred**: implemented only if, after Round 3, per-world crossings
are still more than 5% of the worlds25x19 tick. The fixed per-world costs that matter (timers,
three event headers, embind step marshalling) are removed per world by C, D and I instead.

**K. Legacy embind speed-up (optional).** `makeClassHandle` builds every handle through
`Object.create(proto, {$$: {value, writable: true}})`, V8's slow descriptor path (32–44% of the
stock tick). A post-processing patch of the generated JS could speed up every not-yet-migrated
call site. It is acceptable only if `$$` keeps its exact attributes (non-enumerable,
non-configurable, writable); for example, `JSON.stringify(handle)` must still give `"{}"`.

### 2.2 Ideas: expected gain, risk, effort, proof

Gains are tied to the Phase 1 profile lines (drift2000 numbers in ns/body/step of a 5,532 ns tick
unless stated).

| # | idea | profile lines it removes | expected gain | risk | effort | bit-identity proof |
|---|---|---|---|---|---|---|
| 1 | Bulk move export (C) + typed-array pose-out loop | In `PhysicsPoseSyncOut`: `makeClassHandle` 43.5% (2,406), embind `get` 5.7% (315), `RegisteredPointer_fromWireType` 4.5% (249), `toWireType` 2.6% (144), `validateThis` 2.0% (111), `fromWireType` 1.2% (66), embind-wasm 4.8% (266), wasm-alloc 4.8% (266), GC 1.2% (66), most of the 7.7% loop: **≈3,900 ns/body** | copy-out ~7–10×, tick ~5–8× on drift (the probe reached 10–11× / 7–9×); rest2000 read path ~15×, allocation → 0 | low: public getters in C, same order and moment | M | differential test (every field of every body every step vs embind, `Object.is`), 7 checksums, vecs suites |
| 2 | Raw step + zero-copy contact/sensor/hit spans | `b2World_Step` worldId marshal; `GetBodyEvents` 564, `GetContactEvents` 731, `GetSensorEvents` 680 ns per world-step; per event: begin handle + 2 shapeIds ≈ 750 ns, hit ≈ 1,600 ns (contact `PhysicsEvents` 3.1% ≈ 240 ns/body; worlds25x19 2.7% + headers) | contact events 240 → ~60 ns/body; worlds25x19 −~100 ns/body of per-world headers | low | M | contact checksum hashes every event (other entity, hit point, normal, speed) every step; differential test of spans vs embind events |
| 3 | Profile-timer switch | clock chain: worlds25x19 8.5% of tick (≈575 ns/body, ~70% of its step); 0.2–0.3% elsewhere | worlds25x19 step 840 → ~250 ns/body | low: only `world->profile` and TOI stats read the timers; profile reads 0 when off | S | 7 checksums with the switch off and on; `BENCH_TRACE=1` per-step trace |
| 4 | Generated scalar/out-param body API + composites; migrate pose-in, forces, impulses, kinematic targets, `bodyMotion`, `isAwake` | drive500 forces 1,484 ns/body (16% of its tick); per op: `bodyMotion` ≈2,400 → ~40, `ApplyForceToCenter`+`vec.Set` ≈1,000 → ~15, pose-in ≈1,500–2,000 → ~20, kinematic target ≈3,000 → ~60 ns | drive500 tick −~1,400 ns/body; ~0 on the other scenes (change-driven paths) | low | M (generator) | differential setter test: two identical worlds driven through embind and through `b2x_`, full state compared bitwise every step; drive500 checksum |
| 5 | Integer user data in move records | reverse `ArrayMap` lookup ~3.5 ns | ~0 (completeness) | low; EIDs ≥ 2^32 need the index fallback | S | covered by 1 |
| 6 | Fused step+export; batched multi-world calls | ~10 ns per crossing | ≤ 2 ns/body | fused export reads velocities before any postStep mutation; batching reorders vecs phases | S | 1, 2 |
| 7 | Faster embind handle construction (legacy) | `makeClassHandle` on unmigrated paths | stock-adapter copy-out maybe −30–40%; 0 on migrated paths | medium: embind internals and visible handle semantics | M | vecs suites with the *unmodified* adapter; checksums |
| 8 | Build variants: `-sSTACK_OVERFLOW_CHECK=2` → off in Release, LTO for the Box2D library, wasm-opt level, allocator | box2d self time 4.4% (drift) / 22% (contact) | 0–10% of the step | medium: any result change disqualifies | S each | checksums + per-step trace; dropped with one log line on any change |
| 9 | Threads for big worlds (`b2CreateThreadedWorld`, enkiTS, already in the deluxe glue) | contact `PhysicsStep` 21.5% | contact step maybe 1.5–2.5× | medium: must give the same hash (Box2D tests 1–5 workers); small worlds get slower | S to measure | checksums at 1, 2, 4 workers; reported as an optional vecs setting |
| 10 | Scratch adapter only (vecs side): reuse `PhysicsEvents`' three `Set`s per step, keep doubles unboxed in the loop | allocation | read path to 0 B/step | low | S | vecs suites |

### 2.3 Rounds

Each round: implement, then the proof kit (§2.5), then ≥5 alternating timing rounds against
stock, then a round entry in this file.

| round | content | expected effect (vs Phase 1) |
|---|---|---|
| **R1** | Fast-path foundation (ids, layout JSON, memory export, `fastpath` helper, d.ts), `b2x_World_Step`, `b2x_World_ExportMoves`, user data; differential test; scratch adapter pose-out + step | drift copy-out ~7–10×, tick ~5–8×; rest2000 read path ~0 B/step; contact tick ~2.5×; worlds25x19 ~2.8× |
| **R2** | Event spans + adapter `PhysicsEvents` on spans with reused sets; drop the per-world `GetBodyEvents` header | contact events 240 → ~60; worlds25x19 −~100 ns/body |
| **R3** | Profile-timer patch and switch; adapter turns timers off | worlds25x19 step 840 → ~250; tick ~4× |
| **R4** | Generated `b2x_Body_*` API + composites; adapter migrates pose-in, forces, impulses, kinematic targets, `bodyMotion`, `isAwake` | drive500 ~5×; other scenes unchanged |
| **R5** | Build variants (item 8), each gated; threads for the contact scene (item 9) | 0–10% on the step; contact maybe more with threads |
| **R6** | Whatever the R5 profile ranks first; legacy embind speed-up (item 7) if its semantics can be kept exactly | – |

Stop rule (from the mission): stop after two consecutive rounds that each gain < 5% on the whole
tick. Then record what the remaining cost is made of. Expected: vecs's own `entity.get` / `set` /
flush, the Box2D step, and the vecs systems that run per world per tick.

### 2.4 Targets (committed floors, relative to the Phase 1 baseline)

Measured as same-session alternating ratios against stock (≥5 rounds, medians), and also reported
in absolute ns.

| metric | scene(s) | floor (committed) | stretch | expected |
|---|---|---|---|---|
| copy-out (`PhysicsPoseSyncOut` incl. its flush) | drift500 / drift2000 / drift10000 | **≥ 5× cheaper** | ≥ 10× | 7–10× |
| JS allocations per step on the physics read path | rest2000 (reads every body, writes nothing) | **0 B per body per step**, with any fixed per-step bytes attributed | 0 B per step | 0 |
| whole tick per body | drift500 / drift2000 / drift10000 (no contacts) | **≥ 3× cheaper** | ≥ 6× | 5–8× |
| reported separately | contact | – | – | tick ~2.5–3× (Box2D's step is 22% of baseline and stays, unless threads) |
| reported separately | worlds25x19 | – | – | tick ~4× after R3 |
| reported separately | drive500, rest2000 | – | – | ~5× / ~15× |

On drift scenes, allocations after R1 are expected to be only vecs's `entity.set` path
(~450 B/body/step, measured by the probe). That is vecs-owned and reported with its breakdown.
Zero there would need a vecs API change and is listed in the migration guide, not promised here.

### 2.5 Verification protocol (every round, every build)

1. **Checksums**, all 7 scenes (drift500 `11c76fa7`, drift2000 `a66a94ee`, drift10000 `70623967`,
   contact `5db7f953`, worlds25x19 `a8a0671e`, rest2000 `17fc310b`, drive500 `fd7cc876`). They must
   match stock in the same run, with the scratch adapter *and* with the unmodified adapter on the
   fork build. Build-flag variants also run `BENCH_TRACE=1` (state folded every step).
2. **Differential test** `perf/tests/fastpath-differential.mjs` (box2d only, no vecs), over drift,
   contact and sensor scenes:
   - every exported move record is compared field by field with embind's `GetMoveEvent` /
     `transform` / `GetAngle` / velocity getters with `Object.is`, every body, every step;
   - spans are compared with embind's contact, hit and sensor events;
   - every generated getter is compared with its embind twin;
   - setters: two identical worlds, one driven through embind and one through `b2x_` with the
     same inputs, compared bitwise every step;
   - it runs on deluxe **and** compat, and includes a forced memory-growth phase.
3. **vecs suites**: `@vworlds/vecs-physics` (537 tests), `@vworlds/vecs-phaser-server` (154, incl.
   `motion_accuracy.test.ts` real-WASM DR), `@vworlds/vecs-phaser` (119). They run (a) unmodified
   against the fork build (embind compatibility) and (b) with the scratch adapter.
4. **Timing**: `perf/bench/run.mjs`, ≥5 alternating rounds stock vs fork, medians plus max/min
   spread; allocation pass; a profile for the next round's ranking.

### 2.6 Scratch adapter and migration order (preview of the Phase 4 guide)

The scratch adapter is a local-only branch `scratch/fork-adapter` in the `../vecs-scratch`
worktree (based on `2d58dd7`, never pushed). Call sites in migration order:

1. `adapter/runtime.ts`: create the fast path at preload, allocate scratch/record buffers, turn
   profile timers off (R3).
2. `core/step.ts`: `b2World_Step` → `b2x_World_Step`.
3. `body/pose_out.ts`: header + `GetMoveEvent` + `transform`/`p`/`q` + velocity getters →
   `b2x_World_ExportMoves` + typed-array loop. Same order, same compare-before-write, same
   Dynamic/destroyed checks.
4. `events/publish.ts`: contact/sensor headers and events → spans; reuse the three `Set`s.
5. `body/lifecycle.ts`, `shapes/lifecycle.ts`: keep the packed id on the component; optional
   user data.
6. `adapter/queries.ts`: `bodyMotion` → `b2x_Body_GetMotion`, `isAwake` → raw.
7. `body/pose_in.ts`, `forces/*.ts`, `kinematic/targets.ts`: raw setters and getters.
8. Rare paths (mass, joints, shapes, queries): stay on embind.

### 2.7 Decisions taken in Phase 2

- The fast path is additive and C-level, with no embind changes in R1–R6 except the optional,
  semantics-preserving item 7.
- Copy into a caller-owned buffer for moves (the angle and velocities must come from wasm).
  Zero-copy spans for contact, sensor and hit events (all fields are raw Box2D data).
- The adapter keeps step and export as separate calls (step phase vs postStep). The fused call is
  provided and measured, but not used by default.
- Cross-world batching is deferred (§2.1 J).
- The profile timers default to on; vecs opts out.
- Ids are passed as packed integers; EIDs may ride in user data, with a fallback.
- The per-body API is generated from `box2d.h`, not hand-written.

### 2.8 Risks and open questions for the reviewer

- **Publishing** `@vworlds/box2d3-wasm` needs credentials for the `@vworlds` npm scope (or GitHub
  Packages or a release tarball). It will be checked in Phase 4. Proposed version:
  `5.2.0-vworlds.1`, consumed by vecs as an npm alias (`"box2d3-wasm": "npm:@vworlds/box2d3-wasm@…"`),
  so imports stay unchanged.
- Host noise (13–40% single runs, slow drift between sessions) is handled by same-session
  alternating comparisons only.
- Stale typed views after memory growth are the main correctness hazard of the new API. They are
  covered by the documented rule, `fp.sync()`, and a forced-growth phase in the differential test
  on both flavours.

## Next steps (Phase 3, after go-ahead)

1. R1: add `box2d3-wasm/csrc/fastpath.cpp` (ids, layout JSON, `b2x_World_Step`,
   `b2x_World_GetMoveCount`, `b2x_World_ExportMoves`, `b2x_World_GetMoveEventSpan`, user data),
   compile it in `shell/1_build_wasm.sh`, export `wasmMemory`/`HEAPF32`/`HEAP32`, add the
   `fastpath` helper and its `.d.ts` plus the `package.json` export, write
   `perf/tests/fastpath-differential.mjs`, then migrate `core/step.ts` and `body/pose_out.ts` in
   `../vecs-scratch` (local branch `scratch/fork-adapter`).
2. Run the proof kit (§2.5) and ≥5 alternating rounds; append "Round 1" to this file; continue
   with R2…R6 as planned, re-planning if a round surprises.

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
drift2000 `a66a94ee`, drift10000 `70623967`, contact `5db7f953`, worlds25x19 `a8a0671e`,
rest2000 `17fc310b`, drive500 `fd7cc876`.

Phase 2 probes (measurement only):

```bash
BOX2D_ENTRY=../builds/stock-src/entry.mjs node perf/spikes/raw-crossing.mjs
BOX2D_ENTRY=../builds/stock-prof/entry.mjs node --cpu-prof --cpu-prof-interval 100 \
  --cpu-prof-dir=prof perf/spikes/step-fixed-cost.mjs 19
node perf/bench/analyze-profile.mjs prof/<file>.cpuprofile
```

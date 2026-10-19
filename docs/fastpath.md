# Fast path (`b2x_`) API reference

This page covers the zero-allocation data path that `@vworlds/box2d3-wasm` adds next to the
embind API: what each export does, how memory and layouts work, and how to use them from
JavaScript and TypeScript.

## Guarantees

- **Additive.** The embind API is unchanged. Code that uses it keeps working, so callers can
  move one call site at a time.
- **Same results.** Every `b2x_` function calls the same public Box2D C function(s) as the embind
  binding, with the same arguments. Ids cross as packed integers; floats cross as `f32`, which
  rounds exactly like embind's float conversion. Results are identical bit for bit.
  `tests/fastpath-differential.mjs` (`npm test`) compares 5.47 million values against their embind
  twins on both builds.
- **No per-call allocation.** The raw exports take and return plain numbers. Structs are
  written into wasm memory you own and read through typed arrays.
- **Measured cost:** ~9–35 ns per call vs ~130 ns (a scalar embind call taking an id) to
  ~1,300 ns (one returning a class handle) on the same machine. These numbers come from
  micro-benchmarks that are no longer part of this repository.

## Quick start

`docs/examples/fastpath-example.ts` (typechecked against the built declarations, see
[Verifying](#verifying)):

```ts
// Fast-path usage example for docs/fastpath.md. Typechecked against the built declarations
// (see "Verifying" in docs/fastpath.md).
import Box2DFactory from "@vworlds/box2d3-wasm";
import { createFastPath } from "@vworlds/box2d3-wasm/fastpath";

const box2d = await Box2DFactory();
const fp = createFastPath(box2d);
// Box2D's profile timers only feed b2World_GetProfile; off, a step makes no JavaScript clock calls.
fp.setProfileTimers(false);

// Worlds, bodies and shapes are still created through the embind API.
const def = box2d.b2DefaultWorldDef();
def.gravity.y = -10;
const worldId = box2d.b2CreateWorld(def);
def.delete();
const world = fp.world(worldId); // packed: index1 | generation << 16

const bodyDef = box2d.b2DefaultBodyDef();
bodyDef.type = box2d.b2BodyType.b2_dynamicBody;
const bodyId = box2d.b2CreateBody(worldId, bodyDef);
bodyDef.delete();
const shapeDef = box2d.b2DefaultShapeDef();
const circle = new box2d.b2Circle();
circle.radius = 0.5;
box2d.b2CreateCircleShape(bodyId, shapeDef, circle);
shapeDef.delete();
circle.delete();
// Keep the packed id next to the embind one: raw calls take (index1, rev).
const body = { index1: bodyId.index1, rev: fp.rev(bodyId) };
fp.module._b2x_Body_SetUserData(body.index1, body.rev, 1234); // e.g. your entity id

const moves = fp.createMoveExporter(256);
const M = fp.layout.move;
const { exportVelocity } = fp.layout.constants;

/** One step: a raw step call, then every moved body's pose and velocities in one export call. */
export function step(dt: number, onMove: (userData: number, x: number, y: number, angle: number) => void): void {
  fp.module._b2x_World_Step(world, dt, 4);
  const count = moves.exportMoves(world, exportVelocity); // also syncs the views
  const { u32, f32 } = fp;
  for (let i = 0, base = moves.base; i < count; i++, base += moves.stride) {
    onMove(
      u32[base + (M.userData >> 2)]!,
      f32[base + (M.x >> 2)]!,
      f32[base + (M.y >> 2)]!,
      f32[base + (M.angle >> 2)]! // b2Rot_GetAngle: the same bits embind's q.GetAngle() returns
    );
  }
}

// Contact events, read in place from Box2D's own arrays (valid until the next step).
const spans = fp.alloc(fp.layout.contactSpans.size);
export function contactBegins(onBegin: (shapeIndexA: number, shapeIndexB: number) => void): void {
  fp.module._b2x_World_GetContactSpans(world, spans);
  fp.sync(); // the step may have grown memory
  const S = fp.layout.contactSpans;
  const B = fp.layout.contactBegin;
  const { i32, u32 } = fp;
  const first = u32[(spans + S.beginPtr) >> 2]!;
  const count = i32[(spans + S.beginCount) >> 2]!;
  for (let i = 0; i < count; i++) {
    const at = first + i * B.size;
    onBegin(i32[(at + B.shapeA) >> 2]!, i32[(at + B.shapeB) >> 2]!);
  }
}

// Per-body calls: scalars directly, structs through a scratch out-pointer.
const out = fp.alloc(64);
export function speedOf(index1: number, rev: number): number {
  fp.module._b2x_Body_GetMotion(index1, rev, out);
  const V = fp.layout.motion;
  const f32 = fp.f32;
  return Math.hypot(f32[(out + V.vx) >> 2]!, f32[(out + V.vy) >> 2]!);
}
export function push(index1: number, rev: number): void {
  fp.module._b2x_Body_ApplyLinearImpulseToCenter(index1, rev, 0, 2.5, 1);
}
```

## The `@vworlds/box2d3-wasm/fastpath` helper

`createFastPath(module)` returns a `FastPath`:

| member | what it is |
|---|---|
| `module` | the Box2D module typed as `FastPathModule` (embind API + every `_b2x_*` with named parameters) |
| `memory` | the module's `WebAssembly.Memory` |
| `layout` | the parsed layout JSON (below) |
| `u8`, `u16`, `i32`, `u32`, `f32` | whole-memory typed views; re-read them after `sync()` |
| `sync()` | rebuild the views if memory grew; returns `true` if it did. ~40 ns. |
| `world(worldId)` | packed world id `index1 \| generation << 16` |
| `rev(id)` | second half of a packed body/shape/chain/joint id: `world0 \| generation << 16` |
| `alloc(bytes)` / `free(ptr)` | `malloc` (+ `sync`) / `free` |
| `createMoveExporter(capacity)` | a growable buffer of move records; `exportMoves(world, flags)` returns the count, syncs the views, and exposes `base` and `stride` (words) |
| `setProfileTimers(enabled)` | Box2D's profile timers on (default) or off |

The helper never allocates per step.

## Ids

| Box2D id | fast path |
|---|---|
| `b2WorldId { index1, generation }` (two `uint16`) | one `i32`: `index1 \| generation << 16` (`fp.world(id)`) |
| `b2BodyId`, `b2ShapeId`, `b2ChainId`, `b2JointId` `{ index1, world0, generation }` | two arguments `(index1, rev)`, `rev = world0 \| generation << 16` (`fp.rev(id)`) |

Raw calls do not validate ids. A destroyed id is undefined behavior, as it is with embind.
`b2x_Body_IsValid` is available. `b2ShapeId` / `b2JointId` arrays (`b2x_Body_GetShapes`,
`b2x_Body_GetJoints`) come back as `(index1, rev)` word pairs: that is their memory layout.

## Memory and the growth rule

The build exports `wasmMemory` (plus `HEAPF32` and `HEAP32`). Memory grows during calls that
allocate in wasm, and typed views made before the growth must not be used for new memory.

| calls that **may grow** memory | calls that **never** grow memory |
|---|---|
| creating or destroying worlds, bodies, shapes, joints, chains; `b2World_Step` / `b2x_World_Step` (contact, pair and island arrays grow); embind calls that return a class by value or marshal a value object; `_malloc` / `fp.alloc` | every `b2x_Body_*` / `b2x_Shape_*` getter and setter, `b2x_World_ExportMoves` (into your buffer), `b2x_World_GetMoveCount`, `b2x_World_Get*Spans`, `b2x_GetLayout` after the first call |

Rule: after a call from the left column and before you read memory, call `fp.sync()` (or use
`MoveExporter.exportMoves`, which syncs), then re-read `fp.i32` / `fp.f32` /…. Memory is a plain
(non-shared) `WebAssembly.Memory` in both builds: after growth `memory.buffer` is a new object and
the old buffer is detached (old views become length 0).

## Layout descriptor

`b2x_GetLayout()` returns a C string with JSON. It is built once in C from `sizeof` /
`offsetof`; `fp.layout` is that JSON parsed. All offsets and sizes are in **bytes**. Fields marked
4 are 4-byte aligned (a `static_assert` guarantees it), so read them with
`view[(ptr + offset) >> 2]`. `uint16` fields (`…World0`, `…Generation`) need `u16[(ptr + offset) >> 1]`
and `fellAsleep` needs `u8`.

| struct (`layout.<name>`) | fields |
|---|---|
| `constants` | `version`, `exportVelocity`, `exportDynamicOnly`, `moveFellAsleep`, `moveTypeShift`, `moveValid` |
| `move` (48 B, written by `b2x_World_ExportMoves`) | `bodyIndex` i32, `rev` u32, `userData` u32, `flags` u32, `x` `y` `c` `s` `angle` `vx` `vy` `w` f32 (all 4) |
| `pose` (`b2x_Body_GetPose`) | `x` `y` `c` `s` `angle` f32 |
| `motion` (`b2x_Body_GetMotion`) | `awake` i32, `vx` `vy` `w` `linearDamping` `angularDamping` `localCenterX` `localCenterY` `mass` `gravityScale` f32 |
| `span`, `contactSpans`, `sensorSpans` | `ptr` u32 + `count` i32 per event kind (`beginPtr`, `beginCount`, `endPtr`, `endCount`, `hitPtr`, `hitCount`) |
| `moveEvent` (Box2D's `b2BodyMoveEvent`) | `userData`, `x`, `y`, `c`, `s`, `body` (index1), `bodyWorld0`, `bodyGeneration`, `fellAsleep` |
| `contactBegin`, `contactEnd` | `shapeA`, `shapeAWorld0`, `shapeAGeneration`, `shapeB`, `shapeBWorld0`, `shapeBGeneration`, `contact` |
| `contactHit` | the shape pair fields, `pointX`, `pointY`, `normalX`, `normalY`, `approachSpeed`, `contact` |
| `sensorBegin`, `sensorEnd` | `sensorShape`, `visitorShape` (+ `World0` / `Generation`) |

`move.flags`: bit `moveFellAsleep` = the event's `fellAsleep`; `(flags >> moveTypeShift) & 3` =
`b2BodyType` (0 static, 1 kinematic, 2 dynamic); bit `moveValid` = the body id was valid at export
(velocities are only read then).

## World and step

| export | does | memory |
|---|---|---|
| `_b2x_World_Step(world, timeStep, subStepCount)` | `b2World_Step` | may grow |
| `_b2x_World_GetMoveCount(world)` | move events of the last step | — |
| `_b2x_World_ExportMoves(world, outPtr, capacity, flags)` | one `move` record per move event, **in Box2D's event order**: transform, `b2Rot_GetAngle(q)`, and with `exportVelocity` the values of `b2Body_GetLinearVelocity` / `b2Body_GetAngularVelocity`; `exportDynamicOnly` skips non-dynamic bodies. Returns the record count; if it exceeds `capacity`, grow and call again (events stay valid until the next step) | never |
| `_b2x_World_StepAndExportMoves(world, timeStep, subStepCount, outPtr, capacity, flags)` | step, then export, in one crossing | may grow |
| `_b2x_World_GetMoveEventSpan(world, outPtr)` | `{ptr, count}` of Box2D's own `b2BodyMoveEvent` array | never |
| `_b2x_World_GetContactSpans(world, outPtr)` | begin/end/hit spans of Box2D's contact event arrays | never |
| `_b2x_World_GetSensorSpans(world, outPtr)` | begin/end spans of Box2D's sensor event arrays | never |

Spans point into Box2D's arrays and are valid until the next step or world change. Read the
fields you need in place; nothing is copied.

## Per-body functions

All 65 `b2Body_*` functions in `box2d.h` except names, raw `void*` user data and
`GetContactData` have a generated twin (`scripts/gen_fastpath.py`, `src/fastpath_body.gen.cpp`,
`src/fastpath_body.gen.d.ts`). Conventions:

- `b2Vec2` / `b2Rot` / `b2Transform` / `b2MassData` arguments are flattened to floats (`xX`, `xY`,
  `xC`, `xS`, …).
- `bool` and enums are ints.
- Struct results go to a float `outPtr`.
- `b2WorldId` results are packed.
- `b2MotionLocks` is a bit mask (1 linearX, 2 linearY, 4 angularZ).

| export | calls | returns |
|---|---|---|
| `b2x_Body_IsValid(index1, rev)` | `b2Body_IsValid` | number — 1 or 0 |
| `b2x_Body_GetType(index1, rev)` | `b2Body_GetType` | number — b2BodyType value |
| `b2x_Body_SetType(index1, rev, type)` | `b2Body_SetType` | void |
| `b2x_Body_GetPosition(index1, rev, outPtr)` | `b2Body_GetPosition` | void — out: x, y |
| `b2x_Body_GetRotation(index1, rev, outPtr)` | `b2Body_GetRotation` | void — out: c, s |
| `b2x_Body_GetTransform(index1, rev, outPtr)` | `b2Body_GetTransform` | void — out: px, py, qc, qs |
| `b2x_Body_SetTransform(index1, rev, positionX, positionY, rotationC, rotationS)` | `b2Body_SetTransform` | void |
| `b2x_Body_GetLocalPoint(index1, rev, worldPointX, worldPointY, outPtr)` | `b2Body_GetLocalPoint` | void — out: x, y |
| `b2x_Body_GetWorldPoint(index1, rev, localPointX, localPointY, outPtr)` | `b2Body_GetWorldPoint` | void — out: x, y |
| `b2x_Body_GetLocalVector(index1, rev, worldVectorX, worldVectorY, outPtr)` | `b2Body_GetLocalVector` | void — out: x, y |
| `b2x_Body_GetWorldVector(index1, rev, localVectorX, localVectorY, outPtr)` | `b2Body_GetWorldVector` | void — out: x, y |
| `b2x_Body_GetLinearVelocity(index1, rev, outPtr)` | `b2Body_GetLinearVelocity` | void — out: x, y |
| `b2x_Body_GetAngularVelocity(index1, rev)` | `b2Body_GetAngularVelocity` | number |
| `b2x_Body_SetLinearVelocity(index1, rev, linearVelocityX, linearVelocityY)` | `b2Body_SetLinearVelocity` | void |
| `b2x_Body_SetAngularVelocity(index1, rev, angularVelocity)` | `b2Body_SetAngularVelocity` | void |
| `b2x_Body_SetTargetTransform(index1, rev, targetPx, targetPy, targetQc, targetQs, timeStep, wake)` | `b2Body_SetTargetTransform` | void |
| `b2x_Body_GetLocalPointVelocity(index1, rev, localPointX, localPointY, outPtr)` | `b2Body_GetLocalPointVelocity` | void — out: x, y |
| `b2x_Body_GetWorldPointVelocity(index1, rev, worldPointX, worldPointY, outPtr)` | `b2Body_GetWorldPointVelocity` | void — out: x, y |
| `b2x_Body_ApplyForce(index1, rev, forceX, forceY, pointX, pointY, wake)` | `b2Body_ApplyForce` | void |
| `b2x_Body_ApplyForceToCenter(index1, rev, forceX, forceY, wake)` | `b2Body_ApplyForceToCenter` | void |
| `b2x_Body_ApplyTorque(index1, rev, torque, wake)` | `b2Body_ApplyTorque` | void |
| `b2x_Body_ClearForces(index1, rev)` | `b2Body_ClearForces` | void |
| `b2x_Body_ApplyLinearImpulse(index1, rev, impulseX, impulseY, pointX, pointY, wake)` | `b2Body_ApplyLinearImpulse` | void |
| `b2x_Body_ApplyLinearImpulseToCenter(index1, rev, impulseX, impulseY, wake)` | `b2Body_ApplyLinearImpulseToCenter` | void |
| `b2x_Body_ApplyAngularImpulse(index1, rev, impulse, wake)` | `b2Body_ApplyAngularImpulse` | void |
| `b2x_Body_GetMass(index1, rev)` | `b2Body_GetMass` | number |
| `b2x_Body_GetRotationalInertia(index1, rev)` | `b2Body_GetRotationalInertia` | number |
| `b2x_Body_GetLocalCenter(index1, rev, outPtr)` | `b2Body_GetLocalCenter` | void — out: x, y |
| `b2x_Body_GetWorldCenter(index1, rev, outPtr)` | `b2Body_GetWorldCenter` | void — out: x, y |
| `b2x_Body_SetMassData(index1, rev, massDataMass, massDataCenterX, massDataCenterY, massDataRotationalInertia)` | `b2Body_SetMassData` | void |
| `b2x_Body_GetMassData(index1, rev, outPtr)` | `b2Body_GetMassData` | void — out: mass, centerX, centerY, rotationalInertia |
| `b2x_Body_UpdateMassFromShapes(index1, rev)` | `b2Body_UpdateMassFromShapes` | void |
| `b2x_Body_SetLinearDamping(index1, rev, linearDamping)` | `b2Body_SetLinearDamping` | void |
| `b2x_Body_GetLinearDamping(index1, rev)` | `b2Body_GetLinearDamping` | number |
| `b2x_Body_SetAngularDamping(index1, rev, angularDamping)` | `b2Body_SetAngularDamping` | void |
| `b2x_Body_GetAngularDamping(index1, rev)` | `b2Body_GetAngularDamping` | number |
| `b2x_Body_SetGravityScale(index1, rev, gravityScale)` | `b2Body_SetGravityScale` | void |
| `b2x_Body_GetGravityScale(index1, rev)` | `b2Body_GetGravityScale` | number |
| `b2x_Body_IsAwake(index1, rev)` | `b2Body_IsAwake` | number — 1 or 0 |
| `b2x_Body_SetAwake(index1, rev, awake)` | `b2Body_SetAwake` | void |
| `b2x_Body_WakeTouching(index1, rev)` | `b2Body_WakeTouching` | void |
| `b2x_Body_EnableSleeping(index1, rev, enableSleep)` | `b2Body_EnableSleeping` | void |
| `b2x_Body_IsSleepingEnabled(index1, rev)` | `b2Body_IsSleepingEnabled` | number — 1 or 0 |
| `b2x_Body_SetSleepThreshold(index1, rev, sleepThreshold)` | `b2Body_SetSleepThreshold` | void |
| `b2x_Body_GetSleepThreshold(index1, rev)` | `b2Body_GetSleepThreshold` | number |
| `b2x_Body_SetSafetyFactor(index1, rev, safetyFactor)` | `b2Body_SetSafetyFactor` | void |
| `b2x_Body_GetSafetyFactor(index1, rev)` | `b2Body_GetSafetyFactor` | number |
| `b2x_Body_IsEnabled(index1, rev)` | `b2Body_IsEnabled` | number — 1 or 0 |
| `b2x_Body_Disable(index1, rev)` | `b2Body_Disable` | void |
| `b2x_Body_Enable(index1, rev)` | `b2Body_Enable` | void |
| `b2x_Body_SetMotionLocks(index1, rev, locks)` | `b2Body_SetMotionLocks` | void |
| `b2x_Body_GetMotionLocks(index1, rev)` | `b2Body_GetMotionLocks` | number — bits: 1 linearX, 2 linearY, 4 angularZ |
| `b2x_Body_SetBullet(index1, rev, flag)` | `b2Body_SetBullet` | void |
| `b2x_Body_IsBullet(index1, rev)` | `b2Body_IsBullet` | number — 1 or 0 |
| `b2x_Body_EnableContactRecycling(index1, rev, flag)` | `b2Body_EnableContactRecycling` | void |
| `b2x_Body_IsContactRecyclingEnabled(index1, rev)` | `b2Body_IsContactRecyclingEnabled` | number — 1 or 0 |
| `b2x_Body_EnableContactEvents(index1, rev, flag)` | `b2Body_EnableContactEvents` | void |
| `b2x_Body_EnableHitEvents(index1, rev, flag)` | `b2Body_EnableHitEvents` | void |
| `b2x_Body_GetWorld(index1, rev)` | `b2Body_GetWorld` | number — packed world id |
| `b2x_Body_GetShapeCount(index1, rev)` | `b2Body_GetShapeCount` | number |
| `b2x_Body_GetShapes(index1, rev, shapeArrayPtr, capacity)` | `b2Body_GetShapes` | number — writes up to capacity (index1, rev) pairs to shapeArrayPtr; returns the count |
| `b2x_Body_GetJointCount(index1, rev)` | `b2Body_GetJointCount` | number |
| `b2x_Body_GetJoints(index1, rev, jointArrayPtr, capacity)` | `b2Body_GetJoints` | number — writes up to capacity (index1, rev) pairs to jointArrayPtr; returns the count |
| `b2x_Body_GetContactCapacity(index1, rev)` | `b2Body_GetContactCapacity` | number |
| `b2x_Body_ComputeBounds(index1, rev, outPtr)` | `b2Body_ComputeBounds` | void — out: lowerX, lowerY, upperX, upperY |
| `b2x_Body_GetMinExtent(index1, rev)` | `b2Body_GetMinExtent` | number |
| `b2x_Body_GetMaxExtent(index1, rev)` | `b2Body_GetMaxExtent` | number |
| `b2x_Body_GetMaxExtentFromOrigin(index1, rev)` | `b2Body_GetMaxExtentFromOrigin` | number |

Hand-written composites: one crossing for an exact call sequence.

| export | equivalent to |
|---|---|
| `_b2x_Body_SetPosition(index1, rev, x, y)` | `b2Body_SetTransform(id, {x, y}, b2Body_GetRotation(id))` |
| `_b2x_Body_SetAngle(index1, rev, angle)` | `b2Body_SetTransform(id, b2Body_GetPosition(id), b2MakeRot(angle))` |
| `_b2x_Body_GetPose(index1, rev, outPtr)` | `b2Body_GetPosition`, `b2Body_GetRotation`, `b2Rot_GetAngle` → `layout.pose` |
| `_b2x_Body_GetMotion(index1, rev, outPtr)` | `b2Body_IsAwake`, `GetLinearVelocity`, `GetAngularVelocity`, `GetLinearDamping`, `GetAngularDamping`, `GetLocalCenter`, `GetMass`, `GetGravityScale` → `layout.motion` |

## Integer user data

`_b2x_Body_SetUserData(index1, rev, u32)` / `_b2x_Body_GetUserData` and the `Shape` pair store an
unsigned 32-bit integer in Box2D's `void* userData`. Box2D copies body user data into every move
event, so `move.userData` carries it with no lookup. The embind API exposes the same storage as
`b2Body_SetUserData` / `b2Body_GetUserData` (and the shape, joint and world equivalents), also as an
unsigned 32-bit integer, so `_b2x_Body_GetUserData` and `b2Body_GetUserData` return the same value.

## Profile timers

`_b2x_SetProfileTimers(0|1)` / `fp.setProfileTimers(bool)`, global to the module, default on.
Box2D reads a clock for every timed section of every step (per stage, per sub-step) to fill
`b2World_GetProfile`. In wasm each read is a call out to JavaScript (`performance.now`). Off:
`b2World_GetProfile` reports zeros, and nothing else changes. The timers never feed the
simulation. An empty-world step costs ~3,200 ns with the timers on and ~100 ns with them off;
in a scene of 25 small worlds the step got 4× cheaper. Implemented by
`patches/box2d/0001-runtime-switch-for-profile-timers.patch`.

## TypeScript

`@vworlds/box2d3-wasm/fastpath` exports `createFastPath`, and the types `FastPath`, `MoveExporter`,
`FastPathLayout`, `StructLayout`, `FastPathModule`, `FastPathCoreExports` and
`FastPathBodyExports` (`src/fastpath.d.ts`, `src/fastpath_body.gen.d.ts`). `fp.module` is typed
`FastPathModule`, so every raw export has named parameters. `MainModule` from the emcc-generated
declarations also lists the raw exports, with positional names.

## Versioning

`layout.constants.version` (`B2X_VERSION`, currently 2) changes whenever an exported signature
or record layout changes; `createFastPath` checks it against `_b2x_GetVersion()`. Both builds
(deluxe: SIMD; compat: no SIMD) carry the same fast path.

## Verifying

```bash
npm run build:docker                  # or: npm run build, with emsdk 4.0.18 and TypeScript 5 on PATH
npm test                              # differential test (deluxe, compat) + integration test, on dist/
npm run gen:check                     # generated code is current
npm run test:reference                # bit-identical to the recorded reference for the pinned Box2D (embind and fast path)
npx -p typescript@5.9 tsc --noEmit --strict --target es2022 --module nodenext \
  --moduleResolution nodenext docs/examples/fastpath-example.ts   # the example typechecks
```

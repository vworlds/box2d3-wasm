# Migrating vecs-physics to the fast path

This guide is for the vecs maintainers. It lists each Box2D call site in `lib/vecs-physics`
(and the one in `vecs-phaser-server`): what it calls today, what it should call, the order to
migrate in, and the measured gain per step.

The reference implementation was a scratch adapter written against vecs `2d58dd7`; it is not part
of this repository. With it, every step below kept all seven benchmark checksums identical to
stock box2d3-wasm 5.2.0 and passed `@vworlds/vecs-physics` (536 tests),
`@vworlds/vecs-phaser-server` (154, including `motion_accuracy.test.ts`) and
`@vworlds/vecs-phaser` (119). API reference: [fastpath.md](fastpath.md).

Prices below were measured in one session on the same machine with micro-benchmarks that are no
longer part of this repository (ns per call). This host ran about 2× slower than in Phase 1, so
compare within a row, not across documents.

## Step 0: swap the dependency (no code change)

```jsonc
// lib/vecs-physics/package.json
"box2d3-wasm": "npm:@vworlds/box2d3-wasm@^6.0.0"
```

Once the package is published, the npm alias keeps every `import … from "box2d3-wasm"` unchanged. The flat embind API is
upstream's, unchanged; the object-oriented classes, threading and debug draw that upstream also
ships are not in this package. Unmodified vecs passes all three suites on this package and gives
the stock checksums.

## Call sites, in migration order

| # | file | today (embind) | fast path | runs | price today → fast path | measured effect |
|---|---|---|---|---|---|---|
| 1 | `adapter/runtime.ts` | — | `createFastPath(module)` at preload; a 64-byte scratch for out-parameters; `rev(id)` helper | once | — | — |
| 1 | `adapter/engine.ts`, `core/module.ts` | `worldId` value object | add `fast`, `world` (packed id), `moveExporter`; pack the id at creation | once | — | — |
| 1 | `core/step.ts` | `b2World_Step(worldId, dt, subSteps)` | `_b2x_World_Step(engine.world, dt, subSteps)` | per world-step | removes the worldId value-object marshal (malloc + 2 field calls + free) | with #2, empty-world step 3,202 → 100 ns |
| 1 | `body/pose_out.ts` | `b2World_GetBodyEvents` + per body `GetMoveEvent`, `.bodyId`, `.transform`, `.p`, `.q`, `.x/.y`, `GetAngle`, `b2Body_GetLinearVelocity`, `b2Body_GetAngularVelocity`, `delete`s | one `moveExporter.exportMoves(world, exportVelocity)`, then a typed-array loop over the records (same order, same lookups, same exact compare-before-write) | per moved body per step | ≈ 5,592 → ≈ 48 ns per body (export 21 + reading a record 27) | copy-out 10.4–12.4× on drift 500 / 2,000 (round 1); allocation 3.8 KB → ~0.4 KB per body per step |
| 2 | `adapter/runtime.ts` | profile timers on | `fast.setProfileTimers(false)` at preload | per world-step | Box2D's timer chain (≈ 70% of a small world's step) → 0 | worlds25x19 step 899 → 225 ns/body, tick −33% |
| 2 | `core/reaper.ts`, `forces/impulses.ts`, `events/publish.ts` | `for…of` over possibly empty queues, maps, sets | return early when empty | per world-step | an iterator allocation per loop → 0 | ~1 KB/step less garbage |
| 3 | `events/publish.ts` | `b2World_GetContactEvents` + counts + per event `GetBeginEvent` (handle) / `GetEndEvent` / `GetHitEvent` (handle + `point`/`normal` handles), `b2World_GetSensorEvents` + per event value objects; three `new Set()` per step | `_b2x_World_GetContactSpans` + `_b2x_World_GetSensorSpans` into one scratch block, one `fast.sync()`, records read in place (same order: begins, ends, hits, sensor begins, ends); the three sets allocated once and reused | per world-step + per event | headers 3,138 → 72 ns per world-step; per event ≈ 750 ns (begin) / ≈ 1,600 ns (hit) → a few typed-array reads | events 432 → 147 ns/body (contact), 278 → 40 (worlds25x19) |
| 4 | `body/pose_out.ts` | `entity.get(Position)` etc. (class resolved to its component entity on every call) | component entity ids resolved once: `entity.get(ids.position)` | per moved body per step | removes the class lookup in each of 5 `get`s | whole tick −11% to −17% (round 5) |
| 4 | `body/pose_out.ts`, `body/lifecycle.ts`, `core/reaper.ts` | `entityByBodyIndex.get(index)` + `world.getEntity(eid)` | `engine.bodyEntities[index]` (set at body creation, cleared when reaped; the `destroyed` check stays) | per moved body per step | one map lookup less | whole tick −6% to −10% on three scenes (round 7) |
| 5 | `body/pose_in.ts` | Position: `b2Body_GetRotation` (handle) + `vec.Set` + `b2Body_SetTransform`; Rotation: `b2Body_GetPosition` (handle) + `b2MakeRot` (handle) + `SetTransform`; velocities: `vec.Set` + `SetLinearVelocity`, `SetAngularVelocity` | `_b2x_Body_SetPosition`, `_b2x_Body_SetAngle`, `_b2x_Body_SetLinearVelocity`, `_b2x_Body_SetAngularVelocity` | per user write | ≥ 2,200 → 77; ≥ 2,400 → 79; ≈ 1,170 → 23; ≈ 190 → 23 | change-driven (none in the steady-state scenes) |
| 5 | `forces/gather.ts` | `vec.Set` + `b2Body_ApplyForceToCenter`; `b2Body_ApplyTorque` | `_b2x_Body_ApplyForceToCenter`, `_b2x_Body_ApplyTorque` | per entity with a non-zero Force/Torque per step | ≈ 1,190 → 25; ≈ 190 → 25 | drive500 force gather 1,508 → 262 ns/body, tick −42% |
| 5 | `forces/impulses.ts` | `vec.Set` + `b2Body_ApplyLinearImpulseToCenter`; `b2Body_ApplyAngularImpulse` | `_b2x_Body_ApplyLinearImpulseToCenter`, `_b2x_Body_ApplyAngularImpulse` | per impulse | ≈ 1,190 → 29; ≈ 190 → 25 | change-driven |
| 5 | `kinematic/targets.ts` | `b2Body_GetType`, `GetPosition` (handle), `GetRotation` (handle) + `GetAngle`, `vec.Set` + `SetLinearVelocity`, `SetAngularVelocity`, `SetAwake` | `_b2x_Body_GetType`, `_b2x_Body_GetPosition` (out), `_b2x_Body_GetPose` (out, angle = `b2Rot_GetAngle`), raw setters; the JS target math is unchanged | per kinematic body with a target per step | ≈ 4,200 → ≈ 190 | per kinematic body |
| 5 | `adapter/queries.ts` `bodyMotion` | `IsAwake`, `GetLinearVelocity` (handle), `GetAngularVelocity`, `GetLinearDamping`, `GetAngularDamping`, `GetLocalCenterOfMass` (handle), `GetMass`, `GetGravityScale` | `_b2x_Body_GetMotion` (out, one crossing, same getters in the same order) | per dead-reckoning baseline write (`vecs-phaser-server`) | ≈ 4,100 → 135 | `motion_accuracy.test.ts` passes unchanged |
| 5 | `adapter/queries.ts` `isAwake` | `b2Body_IsAwake` | `_b2x_Body_IsAwake(...) !== 0` | per dead-reckoned entity with an unchanged pose | 229 → 34 | — |

Ship order: 0 → 1 → 2 → 3 → 4 → 5. Each step is independently shippable and verifiable. Step 1
alone delivers 79–99% of the total time saved: 98% on drift500, 95% contact, 85% 25 worlds, 79%
drive500, 99% rest2000 (round-1 vs final ratios against stock). Step 2 matters for many small
worlds, step 3 for event-heavy games, step 5 for force-driven ones.

### Final effect (all steps; same session, 5 alternating rounds, ns per body per step)

| scene | whole tick stock → fast path | copy-out |
|---|---|---|
| drift 500 / 2,000 / 10,000 bodies | 7,171 → 678 / 8,131 → 807 / 8,020 → 1,541 (**10.6× / 10.1× / 5.2×**) | 14.2× / 12.5× / 6.0× |
| contact-heavy pile, 1,000 bodies | 11,366 → 3,067 (**3.7×**) | 7.9× |
| 25 worlds × 19 bodies (Space Rocks shape) | 9,621 → 1,564 (**6.1×**) | 10.7× |
| 500 bodies with a force and torque each step | 10,296 → 1,639 (**6.3×**) | 8.9× |
| 2,000 awake bodies at rest | 6,601 → 295 (**22.4×**) | 32.1× |

These numbers were measured before this repository was restructured, with the benchmarks that
are no longer kept here; the simulation results they ran on are the ones `npm run test:stock`
checks.

## Notes for the vecs change

- **Order and semantics are preserved.**
  - Pose-out visits move records in Box2D's event order.
  - It does the same `Body.type === Dynamic` and `destroyed` checks and the same exact compare
    against the committed component state.
  - Velocities are read with the same Box2D getters at the same moment, inside the export.
  - Events keep their order (contact begins, ends, hits, then sensor begins and ends), and the
    hit point, normal and speed are the same `f32` values.
- **Keep step and export separate** (step phase vs postStep). `b2x_World_StepAndExportMoves`
  exists, but fusing would read velocities before any postStep system runs.
- **Memory.** After `_b2x_World_Step` (it may grow memory), read through views refreshed by
  `exportMoves()` or `fast.sync()`; never cache `fp.f32` across a step.
- **Tests.** Two tests counted embind handles (`tests/lifecycle/pose_out_handles.test.ts`,
  `tests/events/event_handles.test.ts`). They are rewritten to assert the new contract:
  - one export per tick;
  - zero embind body-event, velocity or event-polling calls;
  - components equal to the embind getters;
  - contact, hit and sensor events still delivered (the event assertions were checked to hold
    on unmodified vecs too).

  No other test changes.
- **Docs in vecs** (per vecs's documentation rules): pose-out JSDoc and
  `lib/vecs-physics/architecture/ARCHITECTURE.md` (embind handle rules → fast-path records),
  `docs/systems-and-phases.md` (copy-out cost), `architecture/CHANGELOG.md`.
- **PR #274.** Its supported-API tweak (`c61c2f0`) and the private-pointer prototype become
  unnecessary. `b2x_World_ExportMoves` is the supported, layout-described form of what that
  prototype did, plus velocities, the exact Box2D angle and zero allocations.
- **Rare paths stay on embind:** body/shape/joint/chain creation, mass recompute, materials,
  queries (ray/shape casts, overlaps), debug validation. They can move later with the generated
  `b2x_Body_*` calls where they touch bodies.

## What the fork cannot remove (vecs-side opportunities)

After migration, on moving scenes the vecs ECS is 45–55% of the tick:
- the deferred `entity.set` → `_executeCommand` → `_set` → update routing;
- `entity.get`;
- every system running per world per tick (≈ 28% of the 25-worlds tick).

These are vecs semantics and vecs core, not physics. Cheaper paths would need vecs API work, for
example a bulk in-place pose write that still routes one update per entity, or an empty-system
fast path (both noted in #273). They do not change simulation results, but they are vecs design
decisions.

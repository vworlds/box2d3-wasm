# Migrating to 7.0.0 (Box2D 3.2)

7.0.0 moves the bundled Box2D from `3a4f0da` (v3.1.1 plus 18 commits) to the
[v3.2.0 release](https://github.com/erincatto/box2d/releases/tag/v3.2.0). This guide is for code
that calls the package: what was renamed, what changed meaning, and what to re-check.

**Simulation results change.** v3.2 rewrites much of the solver (restitution, contact recycling,
SAT, island splitting, continuous collision). Every scene of `npm run test:reference` differs from
6.x from the first step or two. Anything that pins exact positions, checksums or step counts must be
regenerated against 7.0.0 and reviewed, not pasted in.

Determinism inside 7.0.0 is unchanged: deluxe and compat, embind and fast path, all give the same
hashes, and two builds from different checkout paths are byte-identical.

## Renamed functions

Same arguments and meaning unless noted.

| 6.x | 7.0.0 |
|---|---|
| `b2Body_GetLocalCenterOfMass` / `GetWorldCenterOfMass` | `b2Body_GetLocalCenter` / `GetWorldCenter` |
| `b2Body_ApplyMassFromShapes` | `b2Body_UpdateMassFromShapes` |
| `b2Body_EnableSleep` / `IsSleepEnabled` | `b2Body_EnableSleeping` / `IsSleepingEnabled` |
| `b2Body_ComputeAABB`, `b2Shape_GetAABB` | `b2Body_ComputeBounds`, `b2Shape_GetBounds` |
| `b2Shape_RayCast(shape, input)` | `b2Shape_CastRay(shape, origin, translation)` (world-space output) |
| `b2World_SetMaximumLinearSpeed` / `Get…` | `b2World_SetMaxLinearSpeed` / `Get…` |
| `b2World_EnableSpeculative` | removed (no switch in 3.2) |
| `b2{Distance,Prismatic,Revolute,Wheel}Joint_SetMotorSpeed` / `Get…` | `…_SetTargetMotorSpeed` / `…_GetTargetMotorSpeed` |
| `b2DistanceJoint_GetMotorForce`, `b2PrismaticJoint_GetMotorForce` | `…_GetCurrentMotorForce` |
| `b2RevoluteJoint_GetMotorTorque`, `b2WheelJoint_GetMotorTorque` | `…_GetCurrentMotorTorque` |
| `b2PrismaticJoint_GetTranslation` / `GetSpeed`, `b2RevoluteJoint_GetAngle` | `…_GetCurrentTranslation` / `…_GetCurrentSpeed`, `…_GetCurrentAngle` |
| `b2DistanceJoint_SetLength` / `GetLength` | `b2DistanceJoint_SetRestLength` / `GetRestLength` |
| `b2DistanceJoint_SetLengthRange(min, max)`, `GetMinLength`, `GetMaxLength` | `b2DistanceJoint_SetLimits(min, max)`, `GetLowerLimit`, `GetUpperLimit` |
| `b2Compute{Circle,Capsule,Polygon,Segment}AABB` | `b2Compute…Bounds` |
| `b2RayCast{Circle,Capsule,Segment,Polygon}` | `b2CastRay…` |
| `b2ShapeCast{Circle,Capsule,Segment,Polygon}`, `b2ShapeCast` | `b2CastShape…`, `b2CastShape` |
| `b2TimeOfImpact`, `b2SegmentDistance` | `b2ComputeTimeOfImpact`, `b2ComputeSegmentDistance` |
| `b2IsValidRotation` | `b2IsValidRot` |

Fast path: the generated `b2x_Body_*` wrappers follow the same renames
(`_b2x_Body_GetLocalCenter`, `_b2x_Body_UpdateMassFromShapes`, `_b2x_Body_EnableSleeping`,
`_b2x_Body_ComputeBounds`, ...), and `_b2x_Body_SetTargetTransform` takes a trailing `wake` (0/1).
`B2X_VERSION` is 2.

## Changed signatures

- **World queries take an origin.** `b2World_OverlapAABB(world, origin, aabb, filter, fn)`,
  `b2World_OverlapShape(world, origin, proxy, filter, fn)`,
  `b2World_CastShape(world, origin, proxy, translation, filter, fn)`,
  `b2World_CastMover(world, origin, mover, translation, filter)` and
  `b2World_CollideMover(world, origin, mover, filter, fn)`. The AABB / proxy / mover is relative to
  `origin`; results stay in world space. To keep 6.x behaviour pass a zero `b2Vec2`.
  `b2World_CastRay` and `b2World_CastRayClosest` already took the ray start as their origin and
  are unchanged.
- **Pre-solve is split in two.** `b2World_SetPreSolveCallback(world, preSolve, preContinuous)`:
  `preSolve(shapeIdA, shapeIdB, manifold)` returns nothing and may edit the `b2Manifold`
  (`manifold.pointCount = 0` disables the contact for this step); `preContinuous(shapeIdA, shapeIdB,
  point, normal)` returns `false` to skip a time-of-impact event. Either may be `null`. The old
  single callback `(shapeIdA, shapeIdB, point, normal) => boolean` is now `preContinuous`, and it
  no longer runs for ordinary contacts.
- **`b2Collide*` take one relative transform** (B in A's frame) and return a `b2LocalManifold`
  (`normal`, `pointCount`, `GetPoint(i)` with `point`, `separation`, `id`, all in A's frame):
  `b2CollideCircles(circleA, circleB, xf)`.
- `b2Body_SetTargetTransform(body, target, timeStep, wake)` gains `wake`.
- `b2DestroyJoint(jointId)` loses `wakeAttached` and no longer wakes the two bodies. For 6.x's
  `b2DestroyJoint(id, true)` call `b2Joint_WakeBodies(id)` first.
- `b2CastRaySegment(segment, input, oneSided)` keeps its `oneSided` flag (as before).

## Changed structs

| struct | change |
|---|---|
| `b2ChainDef` | `count` is `pointCount`; new `ghost1`, `ghost2` (see open chains below); `materialCount` must be 1 or the segment count |
| `b2ManifoldPoint` | `point` (world point) removed; `anchorA` / `anchorB` remain; new `baseSeparation` |
| `b2ShapeCastPairInput` | `transformA` / `transformB` replaced by `transform` (B relative to A) |
| `b2Profile` | `prepareStages` → `solverSetup`, `solveConstraints` → `constraints`, `applyRestitution` → `restitution` |
| `b2PlaneSolverResult` | `translation` → `delta` |
| `b2ContactHitEvent` | new `contactId` (fast path: `layout.contactHit.contact`) |
| `b2WorldDef` | new `restitutionIterations`, `enableRestitutionPropagation`, `capacity` (a `b2Capacity` pre-sizing hint); `contactSpeed` is now bound |
| `b2BodyDef` | new `safetyFactor`, `enableContactRecycling` |
| `b2Counters` | `colorCounts` has 24 entries (was 12; `b2Counters.GetColorCapacity()`); new `awakeContactCount`, `recycledContactCount` |
| `b2JointType` | new `b2_moverJoint`, `b2_pogoJoint`; `b2_filterJoint` now comes before `b2_motorJoint`, so the **numeric** values moved (use the enum, not numbers) |

## Behaviour changes to check

- **Open chains.** In 6.x the first and last points of an open chain were ghost vertices: 4 points
  made 1 segment. In 7.0.0 every point is a segment end (n points make n − 1 segments) and the
  ghosts are `ghost1` / `ghost2`. They default to infinity as a "not set" marker, and an open chain
  without them is **not created**: `b2CreateChain` returns a null id and only logs. Same geometry
  as before: `ghost1 = points[0]`, `ghost2 = points[n-1]`, `SetPoints(points.slice(1, -1))`. Loops
  are unchanged (now allowed from 3 points).
- **Body names** are truncated to 10 characters (`B2_NAME_LENGTH`; was 31).
- **Worker count.** This build has no threads. Box2D 3.2 would start its own thread pool for
  `workerCount > 1`, so `b2CreateWorld` forces it to 1 and `b2World_SetWorkerCount` is not bound.
- **Sleep timing** differs: piles settle and fall asleep, but not on the same step as before.
- **Speed clamp and large constraint errors.** Box2D 3.2 applies `maximumLinearSpeed` (400 m/s by
  default) after the biased constraint solve instead of before it. When a joint or contact needs a
  correction faster than that (a joint created, or bodies teleported, many metres out of place),
  only the light body is clamped and the pair keeps a common velocity it never had: momentum
  appears. Example: two circles of 0.79 kg and 0.03 kg, a length-1 distance joint created 26 m
  apart, 1/30 s steps: 6.x pulls them together and leaves them at rest; 7.0.0 leaves both moving
  at 31 m/s. With a 10 m gap at 1/30 s nothing happens. Create joints near their rest pose and
  teleport jointed bodies together, or raise `maximumLinearSpeed`.

## New in the API

Bound: the mover and pogo joints (`b2DefaultMoverJointDef`, `b2CreateMoverJoint`,
`b2MoverJoint_*`, `b2DefaultPogoJointDef`, `b2CreatePogoJoint`, `b2PogoJoint_*`),
`b2Body_ClearForces`, `b2Body_{Set,Get}SafetyFactor`, `b2Body_{Enable,Is}ContactRecycling…`,
`b2Body_GetMinExtent` / `GetMaxExtent` / `GetMaxExtentFromOrigin`,
`b2World_{Set,Get}RestitutionIterations`, `b2World_{Enable,Is}RestitutionPropagation…`,
`b2World_GetContactTuning` (`{ hertz, dampingRatio, pushSpeed }`),
`b2World_{Set,Get}ContactRecycleDistance`, `b2World_EnableSSE2Fallback`, `b2World_GetBounds`,
`b2World_GetMaxCapacity`, `b2World_GetStateHash` (BigInt), `b2World_GetWorkerCount`,
`b2DistanceJoint_GetSpringForce`, `b2RevoluteJoint_GetCurrentSpeed`, `b2CreateChainSegmentShape`,
`b2Shape_SetChainSegment`, `b2Chain_SetAllSurfaceMaterials`, `b2IsValidPos`,
`b2IsValidWorldTransform`, `b2IsDoublePrecision`, `b2IsAVX2Available`, `b2GetGraphColor`.

Not bound yet (see `scripts/bindings-exceptions.txt`): recording and replay, world snapshots
(`b2World_GetSnapshot`, `b2World_RestoreFromSnapshot`, `b2CreateWorldFromSnapshot`), the standalone
dynamic tree, and the log / assert callbacks.

## vecs

What `@vworlds/vecs-physics` needs, as checked against vecs `1095f0aa` (branch `box2d-3.2` in the
vecs repository has these changes):

- `src/adapter/queries.ts`: pass a zero origin to `b2World_OverlapAABB`, `b2World_OverlapShape`
  and both `b2World_CastShape` calls (results are already world-space, nothing else changes).
- `src/adapter/engine.ts`: the `b2QueryFilter` / `b2AABB` types read
  `Parameters<…b2World_OverlapAABB>` at index 3 / 2 (was 2 / 1).
- `src/joints/features.ts`: `…_SetTargetMotorSpeed` for the four motor joints,
  `b2DistanceJoint_SetLimits`.
- `src/core/reaper.ts`, `src/joints/lifecycle.ts`: `b2Joint_WakeBodies(id)` then `b2DestroyJoint(id)`.
- `src/body/lifecycle.ts`: `b2Body_EnableSleeping`; `src/body/mass.ts`:
  `b2Body_UpdateMassFromShapes`, `b2Body_ComputeBounds`.
- `src/shapes/chain.ts`: open chains pass their first / last point as `ghost1` / `ghost2` and the
  rest as points, so `Chain` keeps its documented meaning (at least four points, ends are ghosts).
- Tests: the renames above plus `b2Shape_GetBounds`, `b2Body_GetLocalCenter`,
  `b2Body_IsSleepingEnabled`.
- Regenerate and review the pose checksums in `bench/physics-pose-out.ts` and anything in
  `motion_accuracy.test.ts` that depends on exact results.

All vecs suites pass unchanged apart from the renames (`@vworlds/vecs-physics` 566,
`@vworlds/vecs-phaser-server` 181 + 1 skipped including `motion_accuracy.test.ts`,
`@vworlds/vecs-phaser` 119), and the `physics-pose-out` checksums do not move.

## Space Rocks

Space Rocks calls only vecs-physics' own query helpers, so it needs no code changes: bump
`@vworlds/vecs-physics` and `@vworlds/box2d3-wasm` together. Its server suite (spacerocks
`c5c066e`, with the vecs `box2d-3.2` build swapped in) typechecks; 1124 tests pass, 1 is skipped
and 4 fail. The four record measured physics:

| test | 6.x | 7.0.0 | cause |
|---|---|---|---|
| `trains/dynamics` › reference head-on impact | heading 5.17°, drift 4.70 m, final speed 0.04 m/s | 3.90°, 5.68 m, 0.49 m/s | solver / restitution changes; re-measure and review the handling |
| `trains/dynamics` › reference side-on impact | heading 3.68°, drift 0.42 m | 4.63°, 0.45 m | same |
| `snapping` › already-touching released bricks | brick 2 slides 0.24 m back into the freed cell by tick 10 | moves 0.19 m, does not snap, drifts 1.1 m by tick 60 | different collapse dynamics |
| `boundaryCrossing/clearance` › jointed convoy | ship–trailer offset (1.00, 0.00) after crossing | (0.91, −0.42), length still 1.0 | the test creates the distance joint while the bodies are ~26 m apart, then teleports only the ship's velocity to zero: the speed-clamp effect above leaves the trailer moving. Create the trailer next to the ship, or reset its velocity too |


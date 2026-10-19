# Updating Box2D

What to consider when moving the `box2d` submodule (currently v3.2.0, `178495b`) to a newer Box2D.
The last move, from `3a4f0da` (v3.1.1 plus 18 commits) to v3.2.0, is written up for users in
[box2d-3.2-migration.md](box2d-3.2-migration.md); the notes marked *(3.2)* below are what it taught.

## 1. It is a release of its own

A newer Box2D changes simulation results: solver changes, different contact ordering, new defaults.
So:

- Make it a deliberate release (a major version bump if results change), with its own release notes.
- Never combine it with an emsdk change, or with any other change that can move floats. If
  results change and you changed two things, you cannot tell which one did it. The toolchain
  (emsdk 4.0.18) and the compiler flags in `scripts/build.sh` stay as they are.
- Do the update on its own branch, in the order below.

## 2. Record the reference before and after

`npm run test:reference` (`tests/reference-differential/`) compares every step of seven scenes with
the hashes recorded for the pinned Box2D. After the update it fails, and it should. Do not weaken
it:

1. Before moving the submodule, build the old pin and keep a copy of `dist/` (for the benchmark
   below). Its reference is already in `tests/reference-differential/reference/`.
2. After the update, run `diff.mjs` on the new build for all four runs (deluxe/compat ×
   embind/fast), check that the four agree with each other, review the change with the Box2D
   release notes, and save one of them as `reference/box2d-<new pin>.json` (same shape as the
   existing files: `box2d.commit`, `box2d.tag`, `recordedFrom`, `scenes`). Point `CURRENT` in
   `run.mjs` at it and `PREVIOUS` at the old one, and add a row to the table in the test's
   README.
3. Look at the scene statistics as well as the hashes: *(3.2)* the `pile` scene stopped reaching
   zero awake bodies, which turned out to be later settling, not broken sleep. Check such things
   with a small probe before accepting them.

The checks that stay valid throughout are the ones between this package's own paths: embind and
fast path, deluxe and compat must give identical hashes (`npm test` and the `fast` runs).

Compare speed too: `node bench/engine.mjs <old dist> <new dist>`.

## 3. The timer patch

`patches/box2d/0001-runtime-switch-for-profile-timers.patch` edits `src/timer.c` (the
`__linux__ || __EMSCRIPTEN__` branch): it adds `b2SetProfileTimers(bool)` /
`b2GetProfileTimers()` and makes `b2GetTicks`, `b2GetMilliseconds` and `b2GetMillisecondsAndReset`
return 0 without reading the clock when the switch is off. `src/fastpath.cpp` declares and exports
the two functions as `b2x_SetProfileTimers` / `b2x_GetProfileTimers`, so the build fails to link
if the patch is missing.

After moving the submodule:

```sh
git -C box2d checkout .                                   # drop the applied patch
git -C box2d apply --check ../patches/box2d/0001-runtime-switch-for-profile-timers.patch
```

If it applies, the build applies it for you. If it does not, re-create it: restore the three
functions' early return and the switch as above, `git -C box2d diff > ...`, and keep it small.
Also check that the timers still only feed `world->profile` and the `B2_SNOOP_TOI_COUNTERS`
statistics (search for `b2GetTicks`, `b2GetMilliseconds`, `b2GetMillisecondsAndReset` call sites).
*(3.2)* `scheduler.c` also uses them for a spin timeout; harmless only because the internal
scheduler never runs here (see threading below).
If Box2D starts using them for anything that affects the simulation (for example adaptive time
budgets), the switch is no longer harmless and the patch has to go or change.

## 4. Regenerate the body wrappers

```sh
npm run gen
git diff src/fastpath_body.gen.cpp src/fastpath_body.gen.d.ts
```

`scripts/gen_fastpath.py` reads `box2d/include/box2d/box2d.h` and writes a `b2x_Body_*` wrapper for
every `b2Body_*` function. Review the diff: new functions appear, removed ones disappear (and
anything in `src/fastpath.cpp` or in docs that mentions them must go too), changed signatures
change the wrapper. The script prints a skipped list (today `SetName`, `GetName`, `SetUserData`,
`GetUserData`, `GetContactData`: names, `void*` user data and contact data cannot be expressed as
numbers). An argument type the script does not know makes it skip that function and list it; add
support for the type, or leave it skipped on purpose. `npm run gen:check` must pass afterwards.
*(3.2)* New typedefs (`b2Pos`, `b2WorldTransform`) silently drop every function that uses them
until `PARAM_TYPES` / `RETURN_TYPES` know them, so compare the wrapper count before and after.

## 5. The hand-written fast path

`src/fastpath.cpp` is the part that can break silently:

- **Layouts.** The struct layouts that JavaScript reads (`b2xMove`, the event structs, ...) are
  published as JSON built from `sizeof` / `offsetof`, so a moved field is picked up. The
  `static_assert`s in `B2X_FIELD` and `B2X_STRUCT` fail the build if a field the fast path
  exposes is no longer 4-byte aligned, or a struct size is no longer a multiple of 4. Read the
  diff of Box2D's `types.h` and `id.h` for the structs used here (`b2BodyMoveEvent`,
  `b2ContactBeginTouchEvent`, `b2ContactEndTouchEvent`, `b2ContactHitEvent`,
  `b2SensorBeginTouchEvent`, `b2SensorEndTouchEvent`, `b2ShapeId`, `b2BodyId`, ...).
- **Id layout.** `b2x_Body_GetShapes` / `b2x_Body_GetJoints` write ids straight into the caller's
  buffer, relying on `b2ShapeId` / `b2JointId` being `(int32 index1, uint16 world0, uint16 generation)`,
  i.e. the `(index1, rev)` word pair. No `static_assert` checks that; check `id.h` yourself.
  `fp.rev(id)` and the packed world id assume the same field sizes.
- **`B2X_VERSION`.** Bump it whenever an exported signature or a record layout changes, because
  `createFastPath` checks it against `_b2x_GetVersion()` so a mismatched helper and module fail
  loudly. A Box2D update that changes a record or a signature the fast path exposes needs a bump;
  one that changes neither does not.

## 6. The embind glue

New, removed or changed C functions and struct fields need `src/glue.cpp` updated, by hand: the
binding list is explicit. Compile errors show removed or renamed symbols, but a new function or a
new field is silently absent until you add it, and a function bound as `&b2Foo` silently takes
its new arity: *(3.2)* `b2DestroyJoint` lost an argument and `b2World_CastMover` gained one with
no compile error. Diff every `B2_API` signature between the pins (the parameter types, not just
the names), and check:

- array sizes the glue hardcodes (*(3.2)* `b2Counters.colorCounts` grew from 12 to 24);
- enum order (*(3.2)* `b2JointType` was reordered);
- defaults that turn into required fields (*(3.2)* an open `b2ChainDef` without `ghost1`/`ghost2`
  is rejected with only a log line);
- threading: this build has no threads. *(3.2)* `workerCount > 1` started Box2D's own scheduler,
  so `b2CreateWorld` forces it to 1 and `b2World_SetWorkerCount` is excepted.

`B2_FORCE_INLINE` (*(3.2)*) is a new declaration macro; `check_bindings.py` reads it with
`B2_INLINE`. Diff `box2d.h`, `types.h`, `collision.h`,
`math_functions.h` and `id.h` between the old and new pin and walk the result. Then regenerate the
public surface and compare (see below), and update `src/Box2D.template.d.ts` only if the factory
signature changed.

## 7. Verify

```sh
npm run build:docker
npm run gen:check
npm run check:bindings
npm test
```

`check:bindings` fails for every function the new headers add (bind it or add it to
`scripts/bindings-exceptions.txt` with a reason) and for every exception or binding that names a
function the new headers no longer declare (delete or rename it).

and the path-independence check: build the same commit with the repository mounted at two
different paths and compare `dist/` (scripts/build-in-docker.sh takes `MOUNT`):

```sh
rm -rf build dist && MOUNT=/w scripts/build-in-docker.sh && (cd dist && find . -type f | sort | xargs sha256sum) > /tmp/a.txt
rm -rf build dist && MOUNT=/somewhere/else/repo scripts/build-in-docker.sh && (cd dist && find . -type f | sort | xargs sha256sum) > /tmp/b.txt
diff /tmp/a.txt /tmp/b.txt && echo identical
```

A new Box2D can introduce `__FILE__` uses (asserts, logging) that would embed host paths if the
`-ffile-prefix-map` flags in `scripts/build.sh` were missing, so also run
`strings dist/*/*.wasm | grep -E '/w/|/home|/opt'` and expect nothing.

## 8. Downstream (vecs)

The vecs physics tests depend on exact results. After a Box2D update:

- The dead-reckoning and motion-accuracy tests (`motion_accuracy.test.ts` in
  `@vworlds/vecs-phaser-server`, and the physics tests that compare poses) can fail or need new
  tolerances.
- The checksums printed by vecs's `bench/physics-pose-out.ts` encode exact results: compare them
  against unmodified vecs on the old build first (so a change is attributed to Box2D, not to
  anything else), then review. *(3.2)* They did not change (that scene has no contacts).
- Space Rocks (`~/src/spacerocks`) uses vecs-physics: run its server suite with the new
  vecs-physics build and this package swapped into its `node_modules`. Its trains, snapping and
  sector-crossing tests record measured physics and are the first to move.
- Run vecs's suites (`@vworlds/vecs-physics`, `@vworlds/vecs-phaser-server`, `@vworlds/vecs-phaser`
  and `test:stress`) against the packed tarball (`npm pack`) before releasing.

Release notes for the package should say that simulation results changed and link the Box2D
release notes.

# Updating Box2D

What to consider when moving the `box2d` submodule (currently `3a4f0da`, v3.1.1 plus 18 commits)
to a newer Box2D.

## 1. It is a release of its own

A newer Box2D changes simulation results: solver changes, different contact ordering, new defaults.
So:

- Make it a deliberate release (a major version bump if results change), with its own release notes.
- Never combine it with an emsdk change, or with any other change that can move floats. If
  results change and you changed two things, you cannot tell which one did it. The toolchain
  (emsdk 4.0.18) and the compiler flags in `scripts/build.sh` stay as they are.
- Do the update on its own branch, in the order below.

## 2. `npm run test:stock` stops being valid

`tests/stock-differential/` compares against `box2d3-wasm@5.2.0`, which contains the old Box2D. After
the update it fails, and it should. Do not weaken it. Replace it:

1. Before the update, with the last release built from the old pin, run the scenes of
   `tests/stock-differential/diff.mjs` (embind and fast, both flavours) and record the per-scene
   `sha` and per-step hashes from the output JSON as reference hashes in the repository.
2. After the update, the same test compares against those recorded hashes instead of the stock
   package, and is expected to differ. Review what changed with the Box2D release notes; do not
   accept new hashes blindly.
3. Drop the `box2d3-wasm` devDependency, and say in `tests/stock-differential/README.md` what the
   hashes were recorded from.

The checks that stay valid are the ones between this package's own paths: the embind and fast
path hashes must still be identical to each other (`npm test` and the `fast` runs).

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
new field is silently absent until you add it. Diff `box2d.h`, `types.h`, `collision.h`,
`math_functions.h` and `id.h` between the old and new pin and walk the result. Then regenerate the
public surface and compare (see below), and update `src/Box2D.template.d.ts` only if the factory
signature changed.

## 7. Verify

```sh
npm run build:docker
npm run gen:check
npm test
```

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
- The pinned checksums in vecs's `bench/physics-pose-out.ts` encode exact results and must be
  regenerated against the new build, with unmodified vecs first (so the change is attributed to
  Box2D, not to anything else), then reviewed. Do not just paste the new values in.
- Run vecs's suites (`@vworlds/vecs-physics`, `@vworlds/vecs-phaser-server`, `@vworlds/vecs-phaser`
  and `test:stress`) against the packed tarball (`npm pack`) before releasing.

Release notes for the package should say that simulation results changed and link the Box2D
release notes.

# Patches against the Box2D submodule

`scripts/build.sh` applies every `box2d/*.patch` here to the `box2d` submodule before generating
the Makefile (idempotently: a patch that already applies in reverse is skipped). Each patch is a
plain `git diff` against Box2D v3.2.0 (`178495b`), kept small so it rebases onto newer Box2D by hand.

| patch | what | effect on results |
|---|---|---|
| `0001-runtime-switch-for-profile-timers.patch` | `b2SetProfileTimers(bool)` in `timer.c` (emscripten branch). When off, `b2GetTicks` / `b2GetMilliseconds*` return 0 without reading the clock. Exported as `b2x_SetProfileTimers`. Default on. | none: the timers only feed `world->profile` and the `B2_SNOOP_TOI_COUNTERS` statistics. Off makes `b2World_GetProfile` report zeros. (Box2D 3.2's internal scheduler also reads them for a spin timeout, but it never runs here: `b2CreateWorld` forces one worker.) |

After `git submodule update`, the submodule shows as modified once a patch is applied; that is
expected. `git -C box2d checkout .` removes the patches; the next build re-applies them.

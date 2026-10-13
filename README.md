# @vworlds/box2d3-wasm

[Box2D](https://github.com/erincatto/box2d) v3 compiled to WebAssembly for browsers and Node.js,
with two ways to call it:

- a flat, C-style [embind](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/embind.html)
  API (`b2CreateWorld`, `b2World_Step`, `b2Body_GetPosition`, ...), and
- a zero-allocation **fast path** (`b2x_*` raw exports and a small helper, `@vworlds/box2d3-wasm/fastpath`)
  that skips embind's marshalling for the calls a game makes every frame.

Both run the same Box2D code. Results are bit-identical to
[`box2d3-wasm` 5.2.0](https://www.npmjs.com/package/box2d3-wasm) in every scene of
`npm run test:stock`.

## Origin

This is a fork of [Birch-san/box2d3-wasm](https://github.com/Birch-san/box2d3-wasm) by Alex Birch and
Erik Sombroek, which wraps Erin Catto's [Box2D](https://github.com/erincatto/box2d). The upstream
project is no longer maintained; this one is maintained by vworlds and its consumer is the
vecs ECS library.

What differs from upstream 5.2.0:

- **Flat C API only.** The object-oriented classes (`World`, `Body`, `Shape`, the joint classes, ...)
  are gone, and so is the box2cpp submodule.
- **No threading.** No `TaskSystem`, no `b2CreateThreadedWorld`, no pthread build, no
  `SharedArrayBuffer` requirement. Memory is not shared.
- **No debug draw.** No `b2DebugDraw`, `b2World_Draw` or the `./utils/*` export.
- **The fast path** (below), plus a small patch to Box2D (`patches/box2d/`) that adds a runtime switch
  for its profile timers.

## Install

```sh
npm install @vworlds/box2d3-wasm
```

The package is not published yet. Until it is, build it from source (see [Build](#build)), run
`npm pack` and install the tarball. It is ESM only.

## Usage

The flat API mirrors Box2D's C API; see Box2D's documentation for what each function does.

```js
import Box2DFactory from "@vworlds/box2d3-wasm";

const b2 = await Box2DFactory();

const worldDef = b2.b2DefaultWorldDef();
worldDef.gravity.y = -10;
const worldId = b2.b2CreateWorld(worldDef);
worldDef.delete();

const bodyDef = b2.b2DefaultBodyDef();
bodyDef.type = b2.b2BodyType.b2_dynamicBody;
bodyDef.position.y = 10;
const bodyId = b2.b2CreateBody(worldId, bodyDef);
bodyDef.delete();

const shapeDef = b2.b2DefaultShapeDef();
shapeDef.density = 1;
const box = b2.b2MakeBox(0.5, 0.5);
b2.b2CreatePolygonShape(bodyId, shapeDef, box);
shapeDef.delete();

for (let i = 0; i < 60; i++) b2.b2World_Step(worldId, 1 / 60, 4);

const p = b2.b2Body_GetPosition(bodyId);
console.log(p.x, p.y); // 0 4.979168891906738
p.delete();

b2.b2DestroyWorld(worldId);
```

Objects that embind returns or that you construct (`b2WorldDef`, `b2Vec2`, ...) are handles into
wasm memory; call `.delete()` when you are done with them.

### Fast path

Ids cross as plain integers, scalars cross directly and structs are written into wasm memory you
own. After each step one call exports the pose of every body that moved.

```js
import Box2DFactory from "@vworlds/box2d3-wasm";
import { createFastPath } from "@vworlds/box2d3-wasm/fastpath";

const b2 = await Box2DFactory();
const fp = createFastPath(b2);

// Worlds, bodies and shapes are created through the flat embind API.
const worldDef = b2.b2DefaultWorldDef();
worldDef.gravity.y = -10;
const worldId = b2.b2CreateWorld(worldDef);
worldDef.delete();
const bodyDef = b2.b2DefaultBodyDef();
bodyDef.type = b2.b2BodyType.b2_dynamicBody;
const bodyId = b2.b2CreateBody(worldId, bodyDef);
bodyDef.delete();
const shapeDef = b2.b2DefaultShapeDef();
shapeDef.density = 1;
b2.b2CreatePolygonShape(bodyId, shapeDef, b2.b2MakeBox(0.5, 0.5));
shapeDef.delete();

// Packed ids for the raw calls.
const world = fp.world(worldId);
const index1 = bodyId.index1;
const rev = fp.rev(bodyId);

const moves = fp.createMoveExporter(256);
const M = fp.layout.move;
for (let i = 0; i < 60; i++) {
  fp.module._b2x_World_Step(world, 1 / 60, 4);
  const count = moves.exportMoves(world, 0); // also refreshes the typed-array views
  for (let n = 0, base = moves.base; n < count; n++, base += moves.stride) {
    const y = fp.f32[base + (M.y >> 2)];
    if (i === 59) console.log("y", y); // y -5.020830154418945
  }
}

// A struct result goes into memory you own.
const out = fp.alloc(64);
fp.module._b2x_Body_GetPose(index1, rev, out);
console.log(fp.f32[(out + fp.layout.pose.y) >> 2]);
fp.free(out);
```

The full reference (exports, memory-growth rule, layouts, events, profile timers) is in
[docs/fastpath.md](docs/fastpath.md).

## Flavours

`dist/` holds two builds of the same code:

| flavour | built with | used when |
|---|---|---|
| `deluxe` | WebAssembly SIMD (`-msimd128 -msse2`) | the runtime validates a SIMD module |
| `compat` | `BOX2D_DISABLE_SIMD=ON` | otherwise |

`dist/entry.mjs` (the `"."` export) checks `WebAssembly.validate` on a tiny SIMD module and
imports one of them. In the scenes of `npm run test:stock` both flavours produce the same hashes.
Both carry the fast path, and `@vworlds/box2d3-wasm/fastpath` works with either.

## Build

Requirements: emsdk **4.0.18**, TypeScript 5 as `tsc` (`emcc --emit-tsd` breaks on TypeScript 6),
cmake, make, git, gawk, Node.js (and Python 3 for `npm run gen`, `gen:check` and `check:bindings`). The output depends on the emsdk version; do not change it together
with anything else.

```sh
git clone --recurse-submodules https://github.com/vworlds/box2d3-wasm
cd box2d3-wasm
```

**With Docker** (nothing else to install):

```sh
npm run build:docker   # builds scripts/Dockerfile into an image on first use, then builds in it
```

**With a local emsdk** (activated in the shell, `source emsdk_env.sh`):

```sh
npm run build
```

Either writes `dist/`. `FLAVOURS="deluxe"` limits the build to one flavour; `TARGET_TYPE=Debug` or
`RelWithDebInfo` builds those instead of Release. Intermediate output goes to `build/`.

The build applies `patches/box2d/*.patch` to the `box2d` submodule, so the submodule shows as
modified afterwards; that is expected. It does not depend on where the repository is checked out:
the same commit built at two different paths gives byte-identical files in `dist/`.

## Test

```sh
npm install        # once; fetches box2d3-wasm 5.2.0 for test:stock
npm test           # fast-path differential test + bindings test (both flavours) + integration test, on dist/
npm run test:stock # step-by-step hashes equal to box2d3-wasm 5.2.0, embind and fast path
npm run gen:check  # the generated fast-path code is current
npm run check:bindings  # every C function is bound or excepted (see API coverage)
npm run test:release    # the release-version script (scripts/release-version.test.mjs)
npm run check:pack      # npm pack would publish only the expected files (needs dist/)
```

`npm run gen` regenerates `src/fastpath_body.gen.cpp` and `src/fastpath_body.gen.d.ts` from
`box2d/include/box2d/box2d.h`.

## API coverage

Rule: **every function of Box2D's public C API (the `B2_API` declarations in `box2d.h`, `types.h`,
`collision.h`, `math_functions.h`, `base.h`) is callable through the flat embind API** under its C
name, except the ones listed with a reason in
[scripts/bindings-exceptions.txt](scripts/bindings-exceptions.txt). The fast path is an optional
shortcut to some of them and does not count towards the rule.

Today that is 397 of 428 declared functions bound; the 31 exceptions are:

- debug draw (`b2World_Draw`, `b2DefaultDebugDraw`), removed on purpose;
- allocator and assert hooks (`b2SetAllocator`, `b2SetAssertFcn`, `b2InternalAssertFcn`), which take
  C function pointers;
- `b2GetMillisecondsAndReset` (in/out `uint64_t*`; use `b2GetTicks` and `b2GetMilliseconds`),
  `b2ShapeDistance` (needs the `b2DistanceInput`/`b2DistanceOutput`/`b2Simplex` value classes);
- the 22 `b2DynamicTree_*` functions (a standalone broadphase tree with raw pointers and callbacks);
- `b2World_DumpMemoryStats` (writes a file; the build has no file system, so the call throws);
- `b2Chain_GetSurfaceMaterialCount` (declared in `box2d.h` but not defined in the pinned Box2D).

Conventions for the awkward ones:

- **User data** (`b2World_/b2Body_/b2Shape_/b2Joint_` `SetUserData`/`GetUserData`) is an unsigned
  32-bit **integer** stored in the `void*`, not an object. It is the same storage as
  `_b2x_Body_SetUserData` / `_b2x_Shape_SetUserData`, so both APIs see the same value; keep your own
  table if you need to attach objects.
- **Names**: `b2Body_SetName(id, string)` / `b2Body_GetName(id)` (Box2D keeps at most 31 characters).
- **Out-parameters** come back as value objects: `b2Joint_GetConstraintTuning(id)` returns
  `{hertz, dampingRatio}`, `b2DistanceJoint_GetSpringForceRange(id)` returns
  `{lowerForce, upperForce}`.
- **`uint64_t`** values (`b2Shape_SetUserMaterial`, `b2GetTicks`) are `BigInt`.
- `b2ContactData` gained a `contactId` property, which `b2Contact_GetData` and `b2Contact_IsValid`
  take.
- Callbacks: bound are the world queries `b2World_OverlapAABB`, `b2World_OverlapShape`,
  `b2World_CastRay`, `b2World_CastShape`, `b2World_CollideMover` (a JS function per call),
  `b2World_SetCustomFilterCallback`, `b2World_SetPreSolveCallback` (free the returned handle with
  `b2World_DeleteCallback`) and `b2World_SetFrictionCallback` / `b2World_SetRestitutionCallback`.
  Not bound: the task system and the allocator/assert hooks above, and debug draw.

`npm run check:bindings` enforces the rule. It parses the `B2_API` declarations (comments and
preprocessor lines stripped, multi-line declarations handled) and the `function("...")` names in
`src/*.cpp`, prints the totals per header, and exits 1 when a declared function is neither bound nor
excepted, when an exception or a Box2D-looking binding names a function the headers no longer
declare (so a Box2D update that removes or renames one is noticed), or when an exception is also
bound. Lines starting with `+` in the exceptions file list package helpers that have no C twin
(`b2Body_GetPointer`, ...). Run it after changing `glue.cpp` or moving the Box2D submodule.

## Demo

`demo/` is a small Phaser 4 site that runs this package on the main thread (flat embind API to create
bodies, the `b2x_` fast path to step and read poses): a pile, a joints scene, sensors and hit events, and
3500 always-moving bodies. It loads whichever flavour `entry.mjs` picks and shows it in the stats readout.
It imports the package from this repository's `dist/`, so build the package first.

```sh
npm run build          # the package, into dist/
npm --prefix demo ci     # once
npm run demo:dev       # http://localhost:5173
npm run demo:build     # static site in demo/dist-site/
```

The demo is not part of the published package (it has its own `package.json`). CI builds it and deploys
`demo/dist-site/` to GitHub Pages from `master`. See [demo/README.md](demo/README.md).

## CI

`.github/workflows/ci.yml` runs on pull requests to `dev` and `master` and on pushes to `dev`. It
builds both flavours once, then runs `gen:check`, `check:bindings`, `test:release`, `npm test`, `npm run test:stock`,
a check of the `npm pack` content, the demo build and the vecs test suites (physics, phaser-server,
phaser) against the vecs commit pinned in `ci/vecs-ref`. The vecs repository is private: the suites
need the `VECS_READ_SECRET` secret and are skipped, with a warning, when it is missing.
`.github/workflows/vecs-nightly.yml` runs the same suites against vecs's `dev` every night and opens
a pull request that moves the pin when they pass. To run them yourself:

```sh
npm pack
scripts/run-vecs-suites.sh <vecs-checkout> vworlds-box2d3-wasm-*.tgz
```

## Releasing

Merge `dev` into `master`. `.github/workflows/publish.yml` builds, tests, and publishes
`@vworlds/box2d3-wasm` to npm with provenance. If the version in `package.json` is not on npm yet it
is released as is, otherwise the patch version is bumped (`scripts/release-version.mjs`, `--dry-run`
shows the decision), committed to `master` with `[skip ci]` and tagged `v<version>`. For a minor or
major release, set the version in `package.json` on `dev` first. `pages.yml` deploys the demo to
GitHub Pages on the same push. [docs/releasing.md](docs/releasing.md) lists the one-time setup.

## Repository layout

| path | contents |
|---|---|
| `src/` | `glue.cpp` (embind bindings), `fastpath.cpp` and `fastpath_body.gen.cpp` (`b2x_` exports), `fastpath.mjs` / `.d.ts` (helper), `entry.mjs` / `.d.ts` (flavour selection), `Box2D.template.d.ts` |
| `scripts/` | `build.sh`, `build-in-docker.sh`, `Dockerfile`, `gen_fastpath.py`, `check_bindings.py`, `bindings-exceptions.txt`, `modify_emscripten_dts.awk`, `release-version.mjs` (+ test), `check-pack.mjs`, `run-vecs-suites.sh` |
| `.github/`, `ci/` | workflows, the build action, `vecs-ref` (the pinned vecs commit) |
| `patches/box2d/` | the patch applied to the Box2D submodule |
| `box2d/` | Box2D (git submodule) |
| `tests/` | `fastpath-differential.mjs`, `bindings.mjs`, `integration.mjs`, `stock-differential/` |
| `demo/` | the Phaser 4 demo site (own `package.json`, not published) |
| `docs/` | [fastpath.md](docs/fastpath.md), [vecs-migration.md](docs/vecs-migration.md), [box2d-update.md](docs/box2d-update.md) |
| `dist/`, `build/` | build output (not committed) |

## Documentation

- [docs/fastpath.md](docs/fastpath.md): the fast-path API.
- [docs/vecs-migration.md](docs/vecs-migration.md): moving vecs-physics from embind to the fast path.
- [docs/box2d-update.md](docs/box2d-update.md): what to do when moving the Box2D submodule.
- [docs/releasing.md](docs/releasing.md): releases, CI secrets and the one-time repository setup.
- [patches/README.md](patches/README.md): the Box2D patch.
- [tests/stock-differential/README.md](tests/stock-differential/README.md): what the stock comparison proves.

## Licence

[MIT](LICENSE). Box2D is MIT licensed too (Erin Catto), and parts of the build output come from
Emscripten and wasm-feature-detect; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

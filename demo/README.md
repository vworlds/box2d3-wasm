# box2d3-wasm demo

A small static site that runs `@vworlds/box2d3-wasm` (imported here as `box2d3-wasm`) on the main thread and draws it with Phaser 4 (`phaser@4.2.0`) directly.
Pick a scene at the top: pile, joints, sensors and hits, drift (3500 always-moving bodies). Click the canvas
to spawn bodies or apply an impulse, drag to pan, scroll to zoom.

## Run

The demo imports the package from this repository's `dist/`, so build the package first (`npm run build` at the
repository root; the demo build stops with "build the package first" if `dist/` is missing).

```sh
cd demo
npm ci
npm run dev        # http://localhost:5173
npm run build      # static site in dist-site/, relative base: works under https://<org>.github.io/<repo>/
npm run preview    # serve dist-site/
npm run check      # headless Chrome check of dist-site/ (see below)
```

From the repository root, `npm run demo:dev` and `npm run demo:build` run the same scripts.

The physics package is imported as `box2d3-wasm` and `box2d3-wasm/fastpath`. Both specifiers are resolved by one
alias in `vite.config.js`: the repository root (`dist/entry.mjs`, `dist/fastpath.mjs`), overridable with
`BOX2D_PKG_DIR`. Nothing else knows where the package is. The package needs no cross-origin isolation, workers or
special headers, so any static host works. `dist/entry.mjs` picks the SIMD ("deluxe") flavour when the browser
supports it and the compat flavour otherwise; both `.wasm` files are emitted into `dist-site/assets/` and the stats
readout shows `wasm deluxe` or `wasm compat`, read from the `.wasm` file the page actually fetched. The emscripten glue
finds its `.wasm` with `new URL("...wasm", import.meta.url)`, which Vite rewrites. A URL query `?renderer=canvas`
forces Phaser's 2D canvas renderer (it ignores tint, so `src/sim.js` bakes colours into per-colour textures there).

## Check

`npm run check` serves the built `dist-site/` on a random localhost port under a subpath and drives every scene in
headless Chrome. For each scene it asserts: no page errors, console errors or failed requests, bodies exist, sampled
body positions change over time, sprite positions equal the physics positions. It also clicks in each scene and
cycles through all scenes five times, asserting that wasm memory does not grow. Environment:

| variable | meaning |
|---|---|
| `CHROME_PATH` | Chrome/Chromium executable (default: puppeteer looks for an installed Chrome) |
| `RENDERER` | `webgl` (default) or `canvas` |
| `SHOTS_DIR` | screenshot directory (default: a new temp dir, printed at the end) |
| `CHROME_ARGS` | extra Chrome flags, replacing the default software-GL (SwiftShader) flags |
| `EXPECT_FLAVOUR` | `deluxe` (default) or `compat` |

The hidden `#boxes` scene (`http://localhost:5173/#boxes`) is a static rendering test: boxes at 0, 30, 45 and 90
degrees in three sizes next to circles and a capsule.

Known rendering caveat: with Chrome's software WebGL (SwiftShader) some small box images are drawn as partial
quads (a rasteriser artefact: the same scene is correct with a real GPU and with `?renderer=canvas`).

## How the fast path drives rendering

Only creation uses the flat embind API (`b2CreateWorld`, `b2CreateBody`, `b2Create*Shape`, `b2Create*Joint`).
Everything per step goes through the `b2x_` fast path (`src/sim.js`):

1. Each body gets an index into the demo's entity list, stored with `_b2x_Body_SetUserData`. Box2D hands it back
   in every move record.
2. A fixed step (1/60 s, 4 sub-steps) runs `_b2x_World_Step`. Profile timers are off.
3. One `createMoveExporter` buffer is filled by a single `exportMoves` call. Only bodies that moved are in it, so
   only their Phaser objects are touched: `userData` finds the entity, `x`, `y`, `angle` are read from the record
   and applied by `place()` in `src/view.js`. The `fellAsleep` flag tints bodies dark when they sleep.
4. `_b2x_World_GetContactSpans` and `_b2x_World_GetSensorSpans` expose Box2D's own event arrays in place. Hit events
   flash a body yellow, sensor begin/end events tint visitors green. Shape indices from the spans map back to
   entities.
5. No per-body embind call happens per frame. Input (impulses, velocities) also uses `b2x_` calls.

Coordinates: Box2D is metres, y up, counter-clockwise. Phaser is pixels, y down. `src/view.js` is the single place
that converts (`PPM = 32`, y and angle are negated).

## Layout

- `src/physics.js` loads the wasm module and the fast-path helper
- `src/sim.js` owns one world plus its Phaser objects: creation helpers, stepping, move export, events, teardown
- `src/scenes/*.js` the scenes: `{ create(ctx), update?(ctx, step), onClick?, destroy? }`
- `src/scenes/boxes.js` hidden static rendering test scene
- `tests/check.mjs` the headless check
- `src/main.js` Phaser setup, scene picker, stats, and the `window.__demo` hook used by headless checks

Switching scenes calls `Sim.destroy()`: `b2DestroyWorld`, the move exporter and scratch buffers are freed, Phaser
children and generated textures are removed.

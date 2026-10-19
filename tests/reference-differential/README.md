# Reference differential (`npm run test:reference`)

Proves that this package computes, step for step, exactly the results recorded for the pinned
Box2D, through both APIs and in both flavours.

`diff.mjs` runs seven deterministic scenes (`pile`, `joints`, `sensors`, `sleepwake`, `churn`,
`multiworld`, `bullets`) and hashes the state of every body and every event after every step
(5,800 step hashes per run, about 73 million values over all runs). `run.mjs` does this for
`dist/` through

- the embind API,
- the `b2x_` fast path (with the profile timers off; each fast value is also compared in-process
  with its embind twin),

for both flavours, deluxe (SIMD) and compat. `cmp.mjs` then fails unless every step hash of every
run equals the reference recorded for the pinned Box2D, and reports (without failing) which
scenes changed against the previous pin, and from which step. Output goes to
`build/reference-differential/`.

Build `dist/` first. Setting `PERTURB=<n>` when running `diff.mjs` by hand changes the first
applied impulse by n ulps; it is a negative control to check that `cmp.mjs` does notice a
difference (about 1000 ulps is needed to move these scenes).

## References

`reference/box2d-<pin>.json` holds, per scene, the final `sha`, the `values` count and every step
hash. `run.mjs` names the current one (`CURRENT`) and the previous one (`PREVIOUS`); `cmp.mjs`
refuses to compare when the `box2d` submodule is not at the commit the current reference was
recorded for.

| file | Box2D | recorded from |
|---|---|---|
| `box2d-3a4f0da.json` | `3a4f0da` (v3.1.1 + 18) | the 6.0.1 sources (emsdk 4.0.18). Identical to [`box2d3-wasm@5.2.0`](https://www.npmjs.com/package/box2d3-wasm) from npm, which this test compared against until 7.0.0: 0 differing step hashes. |
| `box2d-v3.2.0.json` | `178495b` (v3.2.0) | the first 7.0.0 build (emsdk 4.0.18). |

In both, all four runs (deluxe/compat × embind/fast) were identical, and the scenes use only API
that exists in both Box2D versions, so an old build can be re-checked against its reference.

When the Box2D pin moves, record a new reference (see
[docs/box2d-update.md](../../docs/box2d-update.md)); never edit a recorded one.

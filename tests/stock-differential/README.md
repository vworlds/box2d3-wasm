# Stock differential (`npm run test:stock`)

Proves that this package computes exactly what the last upstream release,
[`box2d3-wasm@5.2.0`](https://www.npmjs.com/package/box2d3-wasm) from npm (a devDependency), computes.

`diff.mjs` runs seven deterministic scenes (`pile`, `joints`, `sensors`, `sleepwake`, `churn`,
`multiworld`, `bullets`) and hashes the state of every body and every
event after every step (23,200 step hashes, about 72.9 million values over all runs). `run.mjs`
does this for

- the stock package through its embind API,
- `dist/` through the embind API,
- `dist/` through the `b2x_` fast path (with the profile timers off; each fast value is also
  compared in-process with its embind twin),

for both flavours, deluxe (SIMD) and compat. `cmp.mjs` then fails unless every step hash of every
run equals the stock hash of the same flavour. Output goes to `build/stock-differential/`.

Run `npm install` once (it fetches the stock package) and build `dist/` first. Setting `PERTURB=<n>`
when running `diff.mjs` by hand changes the first applied impulse by n ulps; it is a negative
control to check that `cmp.mjs` does notice a difference (about 1000 ulps is needed to move these
scenes).

## Validity

The comparison holds only while the `box2d` submodule is the same Box2D as the one inside
`box2d3-wasm@5.2.0` (commit `3a4f0da`). Updating Box2D changes simulation results on purpose, and
this test then fails for the right reason. At that point replace it with reference hashes recorded
from the last release; see [docs/box2d-update.md](../../docs/box2d-update.md).

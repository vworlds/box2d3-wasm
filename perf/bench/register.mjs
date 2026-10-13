// Resolution hook for the perf benchmarks.
//
//   BENCH_VECS_ROOT  a built vecs checkout; `@vworlds/vecs*` resolve to its lib/*/dist.
//   BOX2D_ENTRY      optional path to a box2d3-wasm `entry.mjs`; `box2d3-wasm` resolves to it,
//                    so the same vecs build can run against stock and fork builds.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.BENCH_VECS_ROOT) {
  throw new Error("set BENCH_VECS_ROOT to a built vecs checkout");
}
const vecsRoot = resolve(process.env.BENCH_VECS_ROOT);
const box2dEntry = process.env.BOX2D_ENTRY
  ? pathToFileURL(resolve(process.env.BOX2D_ENTRY)).href
  : undefined;
const entries = new Map();

function distEntry(name) {
  let entry = entries.get(name);
  if (entry === undefined) {
    const candidates = [
      join(vecsRoot, "lib", name, "dist", "index.js"),
      join(vecsRoot, "lib", name, "dist", name, "src", "index.js"),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found === undefined) {
      throw new Error(`No build output for @vworlds/${name} under ${vecsRoot}`);
    }
    entry = pathToFileURL(found).href;
    entries.set(name, entry);
  }
  return entry;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const match = /^@vworlds\/(vecs(?:-[a-z]+)*)$/.exec(specifier);
    if (match !== null) {
      return { url: distEntry(match[1]), shortCircuit: true };
    }
    if (box2dEntry !== undefined && specifier === "box2d3-wasm") {
      return { url: box2dEntry, shortCircuit: true };
    }
    if (box2dEntry !== undefined && specifier === "box2d3-wasm/fastpath") {
      return { url: new URL("fastpath.mjs", box2dEntry).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

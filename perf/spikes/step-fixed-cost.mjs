// Spike (measurement only): what a b2World_Step on a tiny world costs, by profile category.
//   BOX2D_ENTRY=<profiling entry.mjs> node --cpu-prof perf/spikes/step-fixed-cost.mjs <bodies>
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { cpus } from "node:os";
globalThis.navigator ??= {};
globalThis.navigator.hardwareConcurrency ??= cpus().length;
const { default: factory } = await import(pathToFileURL(resolve(process.env.BOX2D_ENTRY)).href);
const b = await factory();
const n = Number(process.argv[2] ?? 0);
const def = b.b2DefaultWorldDef();
def.gravity.x = 0;
def.gravity.y = 0;
def.enableSleep = false;
const worldId = b.b2CreateWorld(def);
for (let i = 0; i < n; i++) {
  const bd = b.b2DefaultBodyDef();
  bd.type = b.b2BodyType.b2_dynamicBody;
  bd.position.x = i * 10;
  bd.linearVelocity.x = 0.25;
  const id = b.b2CreateBody(worldId, bd);
  const sd = b.b2DefaultShapeDef();
  const c = new b.b2Circle();
  c.radius = 0.25;
  b.b2CreateCircleShape(id, sd, c);
  bd.delete(); sd.delete(); c.delete();
}
function progressAll(iterations) {
  for (let i = 0; i < iterations; i++) b.b2World_Step(worldId, 1 / 30, 4);
}
progressAll(20000);
const t = performance.now();
progressAll(200000);
console.log(`bodies ${n}: ${((performance.now() - t) * 1e6 / 200000).toFixed(0)} ns per b2World_Step`);

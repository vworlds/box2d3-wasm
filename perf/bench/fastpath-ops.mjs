// Price of each b2x_ fast-path operation in ns per call (the counterpart of embind-ops.mjs),
// measured in isolation against a stepped world of drifting bodies.
//
//   BOX2D_ENTRY=<fork entry.mjs> node perf/bench/fastpath-ops.mjs
import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

globalThis.navigator ??= {};
globalThis.navigator.hardwareConcurrency ??= cpus().length;
const entry = resolve(process.env.BOX2D_ENTRY);
const { default: factory } = await import(pathToFileURL(entry).href);
const { createFastPath } = await import(pathToFileURL(resolve(dirname(entry), "fastpath.mjs")).href);
const b = await factory();
const fp = createFastPath(b);
const L = fp.layout;

const def = b.b2DefaultWorldDef();
def.gravity.x = 0;
def.gravity.y = 0;
def.enableSleep = false;
const worldId = b.b2CreateWorld(def);
const emptyWorldId = b.b2CreateWorld(def);
def.delete();
const world = fp.world(worldId);
const emptyWorld = fp.world(emptyWorldId);

const N = 2000;
const ids = [];
for (let i = 0; i < N; i++) {
  const bd = b.b2DefaultBodyDef();
  bd.type = b.b2BodyType.b2_dynamicBody;
  bd.position.x = i * 10;
  bd.position.y = (i % 7) * 10;
  bd.linearVelocity.x = 0.25;
  bd.angularVelocity = 0.01;
  const id = b.b2CreateBody(worldId, bd);
  bd.delete();
  const sd = b.b2DefaultShapeDef();
  const circle = new b.b2Circle();
  circle.radius = 0.25;
  b.b2CreateCircleShape(id, sd, circle);
  sd.delete();
  circle.delete();
  ids.push(id);
}
const idx = Int32Array.from(ids, (id) => id.index1);
const rev = Int32Array.from(ids, (id) => fp.rev(id));
b._b2x_World_Step(world, 1 / 30, 4);
const exporter = fp.createMoveExporter(N);
const out = fp.alloc(64);
fp.sync();

const results = [];
let sink = 0;
function bench(name, iterations, fn, perCall = 1) {
  for (let i = 0; i < Math.min(iterations, 20000); i++) fn(i);
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn(i);
  const ns = ((performance.now() - start) * 1e6) / (iterations * perCall);
  results.push([name, ns]);
  console.log(`${ns.toFixed(1).padStart(9)} ns  ${name}`);
}
const VEL = L.constants.exportVelocity;
const m = (i) => i % N;

bench("baseline: empty JS loop body", 2e6, (i) => (sink += i));
fp.setProfileTimers(true);
bench("b2x_World_Step(empty world), profile timers ON", 2e5, () => b._b2x_World_Step(emptyWorld, 1 / 30, 4));
fp.setProfileTimers(false);
bench("b2x_World_Step(empty world), profile timers OFF", 2e5, () => b._b2x_World_Step(emptyWorld, 1 / 30, 4));
bench("b2x_World_ExportMoves, per body (2,000 bodies, velocities)", 2000, () => exporter.exportMoves(world, VEL), N);
bench("b2x_World_ExportMoves, per call overhead (empty world)", 1e6, () => b._b2x_World_ExportMoves(emptyWorld, exporter.ptr, 1, VEL));
bench("b2x_World_GetContactSpans + GetSensorSpans + sync", 1e6, () => {
  b._b2x_World_GetContactSpans(world, out);
  b._b2x_World_GetSensorSpans(world, out + 32);
  fp.sync();
});
bench("read one move record (7 typed-array loads)", 1e7, (i) => {
  const base = exporter.base + (i % N) * exporter.stride;
  sink += fp.i32[base] + fp.f32[base + 4] + fp.f32[base + 5] + fp.f32[base + 8] + fp.f32[base + 9] + fp.f32[base + 10] + fp.f32[base + 11];
});
bench("b2x_Body_GetAngularVelocity", 2e6, (i) => (sink += b._b2x_Body_GetAngularVelocity(idx[m(i)], rev[m(i)])));
bench("b2x_Body_IsAwake", 2e6, (i) => (sink += b._b2x_Body_IsAwake(idx[m(i)], rev[m(i)])));
bench("b2x_Body_GetType", 2e6, (i) => (sink += b._b2x_Body_GetType(idx[m(i)], rev[m(i)])));
bench("b2x_Body_GetPosition (out-param) + 2 reads", 2e6, (i) => {
  b._b2x_Body_GetPosition(idx[m(i)], rev[m(i)], out);
  sink += fp.f32[out >> 2] + fp.f32[(out >> 2) + 1];
});
bench("b2x_Body_GetPose (out-param) + angle read", 2e6, (i) => {
  b._b2x_Body_GetPose(idx[m(i)], rev[m(i)], out);
  sink += fp.f32[(out + L.pose.angle) >> 2];
});
bench("b2x_Body_GetMotion (out-param, 8 getters) + 10 reads", 1e6, (i) => {
  b._b2x_Body_GetMotion(idx[m(i)], rev[m(i)], out);
  const w = out >> 2;
  for (let k = 0; k < 10; k++) sink += fp.f32[w + k];
});
bench("b2x_Body_SetLinearVelocity", 2e6, (i) => b._b2x_Body_SetLinearVelocity(idx[m(i)], rev[m(i)], 0.25, 0));
bench("b2x_Body_SetAngularVelocity", 2e6, (i) => b._b2x_Body_SetAngularVelocity(idx[m(i)], rev[m(i)], 0.01));
bench("b2x_Body_ApplyForceToCenter", 2e6, (i) => b._b2x_Body_ApplyForceToCenter(idx[m(i)], rev[m(i)], 0, 0, 0));
bench("b2x_Body_ApplyTorque", 2e6, (i) => b._b2x_Body_ApplyTorque(idx[m(i)], rev[m(i)], 0, 0));
bench("b2x_Body_ApplyLinearImpulseToCenter", 2e6, (i) => b._b2x_Body_ApplyLinearImpulseToCenter(idx[m(i)], rev[m(i)], 0, 0, 0));
bench("b2x_Body_SetPosition (composite: GetRotation + SetTransform)", 1e6, (i) => {
  b._b2x_Body_GetPosition(idx[m(i)], rev[m(i)], out);
  b._b2x_Body_SetPosition(idx[m(i)], rev[m(i)], fp.f32[out >> 2], fp.f32[(out >> 2) + 1]);
}, 1);
bench("b2x_Body_SetAngle (composite: GetPosition + b2MakeRot + SetTransform)", 1e6, (i) => b._b2x_Body_SetAngle(idx[m(i)], rev[m(i)], 0.3));

console.log(`FASTPATH_OPS_RESULT ${JSON.stringify(Object.fromEntries(results.map(([k, v]) => [k, +v.toFixed(1)])))}`);
if (sink === 0.5) console.log(sink);
process.exit(0);

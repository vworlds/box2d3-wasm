// Price of each Box2D binding operation vecs-physics performs per step, in ns per call, measured
// in isolation against a stepped world of drifting bodies.
//
//   BOX2D_ENTRY=<entry.mjs> node perf/bench/embind-ops.mjs
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { cpus } from "node:os";
import { resolve } from "node:path";

globalThis.navigator ??= {};
globalThis.navigator.hardwareConcurrency ??= cpus().length;
const entry = process.env.BOX2D_ENTRY ?? "box2d3-wasm";
const { default: factory } = await import(
  entry.startsWith(".") || entry.startsWith("/") ? pathToFileURL(resolve(entry)).href : entry
);
const b = await factory();

const def = b.b2DefaultWorldDef();
def.gravity.x = 0;
def.gravity.y = 0;
def.enableSleep = false;
const worldId = b.b2CreateWorld(def);
def.delete();
const emptyDef = b.b2DefaultWorldDef();
const emptyWorldId = b.b2CreateWorld(emptyDef);
emptyDef.delete();

const N = 2000;
const bodyIds = [];
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
  bodyIds.push(id);
}
b.b2World_Step(worldId, 1 / 30, 4);

const results = [];
function bench(name, iterations, fn) {
  for (let i = 0; i < Math.min(iterations, 20000); i++) fn(i);
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn(i);
  const ns = ((performance.now() - start) * 1e6) / iterations;
  results.push([name, ns]);
  console.log(`${ns.toFixed(1).padStart(9)} ns  ${name}`);
}

const events = b.b2World_GetBodyEvents(worldId);
const moveCount = events.moveCount;
const move0 = events.GetMoveEvent(0);
const transform0 = move0.transform;
const p0 = transform0.p;
const q0 = transform0.q;
const vec = new b.b2Vec2();
const rot = b.b2MakeRot(0.3);
let sink = 0;

bench("baseline: empty JS loop body", 2e6, (i) => (sink += i));
bench("b2World_Step(emptyWorld) — call + worldId marshal", 2e5, () => b.b2World_Step(emptyWorldId, 1 / 30, 4));
bench("b2World_GetBodyEvents(worldId) + delete", 5e5, () => b.b2World_GetBodyEvents(worldId).delete());
bench("bodyEvents.moveCount", 2e6, () => (sink += events.moveCount));
bench("bodyEvents.GetMoveEvent(i) + delete", 1e6, (i) => events.GetMoveEvent(i % moveCount).delete());
bench("move.bodyId (value_object read)", 1e6, () => (sink += move0.bodyId.index1));
bench("move.transform (reference handle)", 1e6, () => move0.transform);
bench("transform.p (reference handle)", 1e6, () => transform0.p);
bench("transform.q (reference handle)", 1e6, () => transform0.q);
bench("vec2.x (float getter)", 2e6, () => (sink += p0.x));
bench("q.GetAngle()", 1e6, () => (sink += q0.GetAngle()));
bench("b2Body_GetLinearVelocity(bodyId) + .x/.y + delete", 1e6, (i) => {
  const v = b.b2Body_GetLinearVelocity(bodyIds[i % N]);
  sink += v.x + v.y;
  v.delete();
});
bench("b2Body_GetAngularVelocity(bodyId)", 1e6, (i) => (sink += b.b2Body_GetAngularVelocity(bodyIds[i % N])));
bench("b2Body_GetPosition(bodyId) + delete", 1e6, (i) => b.b2Body_GetPosition(bodyIds[i % N]).delete());
bench("b2Body_GetRotation(bodyId) + delete", 1e6, (i) => b.b2Body_GetRotation(bodyIds[i % N]).delete());
bench("b2Body_GetTransform(bodyId) + delete", 1e6, (i) => b.b2Body_GetTransform(bodyIds[i % N]).delete());
bench("b2Body_IsAwake(bodyId)", 1e6, (i) => (sink += b.b2Body_IsAwake(bodyIds[i % N])));
bench("b2Body_GetType(bodyId)", 1e6, (i) => (sink += b.b2Body_GetType(bodyIds[i % N]).value ?? 0));
bench("b2Body_GetMass(bodyId)", 1e6, (i) => (sink += b.b2Body_GetMass(bodyIds[i % N])));
bench("b2Body_SetLinearVelocity(bodyId, vec) [vec.Set first]", 1e6, (i) => {
  const v = b.b2Body_GetLinearVelocity(bodyIds[i % N]);
  vec.Set(v.x, v.y);
  v.delete();
  b.b2Body_SetLinearVelocity(bodyIds[i % N], vec);
});
bench("vec.Set(x, y)", 2e6, () => vec.Set(1, 2));
bench("b2Body_SetAngularVelocity(bodyId, w)", 1e6, (i) => b.b2Body_SetAngularVelocity(bodyIds[i % N], b.b2Body_GetAngularVelocity(bodyIds[i % N])));
bench("b2Body_ApplyForceToCenter(bodyId, zeroVec, false)", 1e6, (i) => {
  vec.Set(0, 0);
  b.b2Body_ApplyForceToCenter(bodyIds[i % N], vec, false);
});
bench("b2MakeRot(angle) + delete", 1e6, (i) => b.b2MakeRot(i * 1e-6).delete());
bench("b2World_GetContactEvents(worldId) + counts + delete", 5e5, () => {
  const c = b.b2World_GetContactEvents(worldId);
  sink += c.beginCount + c.endCount + c.hitCount;
  c.delete();
});
bench("b2World_GetSensorEvents(worldId) + counts + delete", 5e5, () => {
  const s = b.b2World_GetSensorEvents(worldId);
  sink += s.beginCount + s.endCount;
  s.delete();
});
void rot;
console.log(`OPS_RESULT ${JSON.stringify(Object.fromEntries(results.map(([k, v]) => [k, +v.toFixed(1)])))}`);
if (sink === 0.5) console.log(sink);

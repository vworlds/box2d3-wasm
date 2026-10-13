// Box2D-only step benchmark (no vecs): ns per body per b2x_World_Step, for build-flag variants.
//   BOX2D_ENTRY=<entry.mjs> node perf/spikes/step-bench.mjs <contact|worlds|drive>
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
globalThis.navigator ??= {};
globalThis.navigator.hardwareConcurrency ??= cpus().length;
const entry = resolve(process.env.BOX2D_ENTRY);
const { default: factory } = await import(pathToFileURL(entry).href);
const { createFastPath } = await import(pathToFileURL(resolve(dirname(entry), "fastpath.mjs")).href);
const b = await factory();
const fp = createFastPath(b);
fp.setProfileTimers(false);
const scene = process.argv[2] ?? "contact";
const DYN = b.b2BodyType.b2_dynamicBody, STA = b.b2BodyType.b2_staticBody;
function world(gy) { const d = b.b2DefaultWorldDef(); d.gravity.y = gy; d.enableSleep = false; const w = b.b2CreateWorld(d); d.delete(); return w; }
function body(w, type, x, y, vx, wz, shape) {
  const bd = b.b2DefaultBodyDef(); bd.type = type; bd.position.x = x; bd.position.y = y; bd.linearVelocity.x = vx; bd.angularVelocity = wz;
  const id = b.b2CreateBody(w, bd); bd.delete(); const sd = b.b2DefaultShapeDef();
  if (shape.box) b.b2CreatePolygonShape(id, sd, b.b2MakeBox(shape.box[0], shape.box[1]));
  else { const c = new b.b2Circle(); c.radius = shape.radius; b.b2CreateCircleShape(id, sd, c); c.delete(); }
  sd.delete(); return id;
}
const worlds = []; let bodies = 0; const forced = [];
if (scene === "contact") {
  const w = world(-10); worlds.push(w);
  body(w, STA, 0, -1, 0, 0, { box: [26, 1] }); body(w, STA, -26, 30, 0, 0, { box: [1, 31] }); body(w, STA, 26, 30, 0, 0, { box: [1, 31] });
  for (let i = 0; i < 1000; i++) { const c = i % 40, r = Math.floor(i / 40); body(w, DYN, -24 + c * 1.2 + (r % 2) * 0.3, 1 + r * 1.2, 0, 0, i % 3 ? { radius: 0.45 } : { box: [0.45, 0.4] }); bodies++; }
} else if (scene === "worlds") {
  for (let k = 0; k < 25; k++) { const w = world(0); worlds.push(w); for (let i = 0; i < 19; i++) { body(w, DYN, i * 10, (i % 7) * 10, 0.25 + ((i + k) % 13) * 0.01, ((i + k) % 5) * 0.01, { radius: 0.25 }); bodies++; } }
} else {
  const w = world(0); worlds.push(w);
  for (let i = 0; i < 500; i++) { forced.push(body(w, DYN, i * 10, (i % 7) * 10, 0.25, 0.01, { radius: 0.25 })); bodies++; }
}
const packed = worlds.map((w) => fp.world(w));
const revs = forced.map((id) => fp.rev(id));
function tick() {
  for (let i = 0; i < forced.length; i++) { b._b2x_Body_ApplyForceToCenter(forced[i].index1, revs[i], 0.05, -0.05, 1); b._b2x_Body_ApplyTorque(forced[i].index1, revs[i], 0.001, 1); }
  for (const w of packed) b._b2x_World_Step(w, 1 / 30, 4);
}
for (let i = 0; i < 300; i++) tick();
const t = performance.now(); const N = 1000;
for (let i = 0; i < N; i++) tick();
console.log(JSON.stringify({ scene, nsPerBodyStep: +(((performance.now() - t) * 1e6) / (N * bodies)).toFixed(1) }));
process.exit(0);

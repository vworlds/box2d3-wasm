// Threads probe (measurement only): does stepping a contact-heavy world with the deluxe glue's
// enkiTS task system (b2CreateThreadedWorld) give bit-identical results, and is it faster?
//
//   BOX2D_ENTRY=<fork entry.mjs> node perf/spikes/threads.mjs
//
// Builds the same 1,000-body pile per configuration, steps 600 times, hashes every exported move
// record (pose, angle, velocities) of every step, and reports ns per body per step.
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
const DYN = b.b2BodyType.b2_dynamicBody;
const STA = b.b2BodyType.b2_staticBody;

function build(workers) {
  const def = b.b2DefaultWorldDef();
  def.gravity.y = -10;
  def.enableSleep = false;
  let worldId;
  let system;
  if (workers === 0) {
    worldId = b.b2CreateWorld(def);
  } else {
    system = new b.TaskSystem(workers);
    worldId = b.b2CreateThreadedWorld(def, system);
  }
  def.delete();
  const body = (type, x, y, shape) => {
    const bd = b.b2DefaultBodyDef();
    bd.type = type;
    bd.position.x = x;
    bd.position.y = y;
    const id = b.b2CreateBody(worldId, bd);
    bd.delete();
    const sd = b.b2DefaultShapeDef();
    if (shape.box) {
      b.b2CreatePolygonShape(id, sd, b.b2MakeBox(shape.box[0], shape.box[1]));
    } else {
      const c = new b.b2Circle();
      c.radius = shape.radius;
      b.b2CreateCircleShape(id, sd, c);
      c.delete();
    }
    sd.delete();
  };
  body(STA, 0, -1, { box: [26, 1] });
  body(STA, -26, 30, { box: [1, 31] });
  body(STA, 26, 30, { box: [1, 31] });
  for (let i = 0; i < 1000; i++) {
    const col = i % 40;
    const row = Math.floor(i / 40);
    body(DYN, -24 + col * 1.2 + (row % 2) * 0.3, 1 + row * 1.2, i % 3 === 0 ? { box: [0.45, 0.4] } : { radius: 0.45 });
  }
  return { worldId, system };
}

const results = [];
for (const workers of [0, 1, 2, 4]) {
  const { worldId, system } = build(workers);
  const world = fp.world(worldId);
  const exporter = fp.createMoveExporter(1024);
  let hash = 2166136261;
  let ms = 0;
  for (let step = 0; step < 600; step++) {
    const t = performance.now();
    if (workers === 0) {
      b._b2x_World_Step(world, 1 / 30, 4);
    } else {
      b.b2World_Step(worldId, 1 / 30, 4);
      system.ClearTasks();
    }
    if (step >= 100) ms += performance.now() - t;
    const n = exporter.exportMoves(world, fp.layout.constants.exportVelocity);
    const words = n * exporter.stride;
    for (let k = 0; k < words; k++) {
      if (k % exporter.stride === fp.layout.move.rev >> 2) continue;
      hash = Math.imul(hash ^ fp.u32[exporter.base + k], 16777619) >>> 0;
    }
  }
  results.push({ workers, nsPerBodyStep: +((ms * 1e6) / (1000 * 500)).toFixed(0), hash: hash.toString(16) });
  console.log(JSON.stringify(results.at(-1)));
}
const same = results.every((r) => r.hash === results[0].hash);
console.log(same ? "THREADS identical state hash for every worker count" : "THREADS hash differs");
process.exit(0);

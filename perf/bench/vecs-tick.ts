// Real-WASM vecs physics tick benchmark: one scene per process.
//
//   BENCH_VECS_ROOT=<vecs checkout> [BOX2D_ENTRY=<entry.mjs>] \
//   node --import ./perf/bench/register.mjs \
//     perf/bench/vecs-tick.ts <scene>
//
// Scenes:
//   drift500, drift2000, drift10000  the vecs bench/physics-pose-out.ts scene (identical setup,
//                                     identical checksum for 500 / 2,000)
//   contact                           a gravity pile in a box: 1,000 dynamic circles and boxes,
//                                     contact, hit and sensor events enabled on a subset
//   worlds25x19                       25 independent worlds of 19 drifting bodies (Space Rocks)
//   rest2000                          2,000 awake bodies at rest (sleep disabled): every body is in
//                                     the move events every step but nothing changes, so the tick
//                                     is the pure read path (no component writes)
//   drive500                          500 drifting bodies, each pushed by a constant Force and
//                                     Torque every step (per-step force crossings, 4 writes/body)
//
// BENCH_TRACE=1 folds every body's pose and velocities into the checksum after every measured step
// (a per-step trace, for build-flag variants), instead of only at the end.
//
// Prints one `TICK_RESULT {json}` line. Timings are ns per body per step; `allocBytesPerStep` is
// the JS heap growth per step over a GC-free window, i.e. bytes allocated per step.
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { PerformanceObserver, performance } from "node:perf_hooks";
import v8 from "node:v8";

import { ChildOf, System, World, type Entity } from "@vworlds/vecs";
import {
  AngularVelocity,
  Body,
  BodyType,
  Box,
  Circle,
  ContactEvents,
  Detectable,
  Force,
  HitEvents,
  LinearVelocity,
  PhysicsModule,
  Position,
  preloadPhysics,
  Rotation,
  Sensor,
  SensorEvents,
  Torque,
} from "@vworlds/vecs-physics";

type Scene = {
  worlds: World[];
  bodies: Entity[];
  /** Folded into the checksum after every measured step (events, for the contact scene). */
  digestStep?: (hash: number) => number;
};

const dt = 1 / 30;
const scratch = new DataView(new ArrayBuffer(8));
const eventCounts = { contactBegin: 0, contactEnd: 0, sensorBegin: 0, sensorEnd: 0, hits: 0 };
const sceneName = process.argv[2] ?? process.env.BENCH_SCENE ?? "drift500";
const defaults: Record<string, [number, number]> = {
  drift500: [300, 1000],
  drift2000: [300, 1000],
  drift10000: [300, 300],
  contact: [300, 600],
  worlds25x19: [300, 1000],
  rest2000: [300, 1000],
  drive500: [300, 1000],
};
const traceEveryStep = process.env.BENCH_TRACE === "1";
if (!(sceneName in defaults)) {
  throw new Error(`unknown scene ${sceneName}`);
}
// Empty means unset.
const warmup = Number(process.env.BENCH_WARMUP_TICKS || defaults[sceneName]![0]);
const steps = Number(process.env.BENCH_TICKS || defaults[sceneName]![1]);

await preloadPhysics();
const scene = buildScene(sceneName);
const count = scene.bodies.length;

const timers = { pose: 0, step: 0, events: 0, forces: 0 };
for (const world of scene.worlds) {
  world.progress(0, dt);
  instrument(world, "PhysicsPoseSyncOut", "pose");
  instrument(world, "PhysicsStep", "step");
  instrument(world, "PhysicsEvents", "events");
  instrument(world, "PhysicsForceGather:Force", "forces");
  instrument(world, "PhysicsForceGather:Torque", "forces");
}

let tick = 0;
function progressAll(): void {
  tick++;
  for (const world of scene.worlds) {
    world.progress(tick * dt, dt);
  }
}

for (let i = 0; i < warmup; i++) {
  progressAll();
}
timers.pose = timers.step = timers.events = timers.forces = 0;
// BENCH_HEAP_SAMPLE=<file>: sample every allocation of the measured loop, garbage included (the
// inspector's sampling heap profiler with collected objects kept), and write the profile.
const heapSampleFile = process.env.BENCH_HEAP_SAMPLE;
const heapSession = heapSampleFile ? new Session() : undefined;
if (heapSession !== undefined) {
  heapSession.connect();
  await heapSession.post("HeapProfiler.startSampling", {
    samplingInterval: 64,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
let hash = 2166136261;
let tickMs = 0;
for (let i = 0; i < steps; i++) {
  const start = performance.now();
  progressAll();
  tickMs += performance.now() - start;
  if (scene.digestStep !== undefined) {
    hash = scene.digestStep(hash);
  }
  if (traceEveryStep) {
    hash = digestBodies(hash, scene.bodies);
  }
}
if (heapSession !== undefined) {
  const { profile } = await heapSession.post("HeapProfiler.stopSampling");
  writeFileSync(heapSampleFile!, JSON.stringify(profile));
  heapSession.disconnect();
}
hash = digestBodies(hash, scene.bodies);

const measured = { ...timers };
// Allocation needs a young generation big enough to hold a whole window, which distorts timing, so
// it is a separate mode: BENCH_MODE=alloc with --expose-gc --min/max-semi-space-size=1024.
const alloc =
  process.env.BENCH_MODE === "alloc"
    ? await measureAllocation(progressAll)
    : { bytesPerStep: -1, window: 0 };

const perBodyStep = (ms: number) => Number(((ms * 1e6) / (count * steps)).toFixed(1));
console.log(
  `TICK_RESULT ${JSON.stringify({
    scene: sceneName,
    bodies: count,
    worlds: scene.worlds.length,
    warmup,
    steps,
    tickNs: perBodyStep(tickMs),
    poseNs: perBodyStep(measured.pose),
    stepNs: perBodyStep(measured.step),
    eventsNs: perBodyStep(measured.events),
    forcesNs: perBodyStep(measured.forces),
    otherNs: perBodyStep(
      tickMs - measured.pose - measured.step - measured.events - measured.forces
    ),
    allocBytesPerStep: alloc.bytesPerStep,
    allocWindow: alloc.window,
    checksum: hash.toString(16).padStart(8, "0"),
    ...(traceEveryStep ? { trace: true } : {}),
    ...(scene.digestStep !== undefined ? { events: eventCounts } : {}),
  })}`
);
for (const world of scene.worlds) {
  world.dispose();
}

function buildScene(name: string): Scene {
  switch (name) {
    case "drift500":
      return driftScene(500);
    case "drift2000":
      return driftScene(2000);
    case "drift10000":
      return driftScene(10000);
    case "contact":
      return contactScene();
    case "worlds25x19":
      return manyWorldsScene(25, 19);
    case "rest2000":
      return restScene(2000);
    case "drive500":
      return driveScene(500);
  }
  throw new Error(name);
}

/** Identical to vecs bench/physics-pose-out.ts `run(count)`. */
function driftScene(n: number): Scene {
  const world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: 0 }, fixedTimeStep: dt, enableSleep: false });
  const bodies = [];
  for (let i = 0; i < n; i++) {
    bodies.push(driftBody(world, i, 0));
  }
  return { worlds: [world], bodies };
}

function driftBody(world: World, i: number, salt: number): Entity {
  const body = world
    .entity()
    .set(Body, { type: BodyType.Dynamic })
    .set(Position, { x: i * 10, y: (i % 7) * 10 })
    .set(Rotation, { angle: ((i + salt) % 11) * 0.1 })
    .set(LinearVelocity, { x: 0.25 + ((i + salt) % 13) * 0.01, y: -0.125 })
    .set(AngularVelocity, { value: ((i + salt) % 5) * 0.01 });
  world.entity().add(ChildOf, body).set(Circle, { radius: 0.25 });
  return body;
}

/** Awake bodies at rest: Box2D reports all of them every step, and none of their values change. */
function restScene(n: number): Scene {
  const world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: 0 }, fixedTimeStep: dt, enableSleep: false });
  const bodies = [];
  for (let i = 0; i < n; i++) {
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: i * 10, y: (i % 7) * 10 })
      .set(Rotation, { angle: (i % 11) * 0.1 })
      .set(LinearVelocity, { x: 0, y: 0 })
      .set(AngularVelocity, { value: 0 });
    world.entity().add(ChildOf, body).set(Circle, { radius: 0.25 });
    bodies.push(body);
  }
  return { worlds: [world], bodies };
}

/** Drifting bodies pushed by a constant force and torque every step, like thrusting ships. */
function driveScene(n: number): Scene {
  const world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: 0 }, fixedTimeStep: dt, enableSleep: false });
  const bodies = [];
  for (let i = 0; i < n; i++) {
    const body = driftBody(world, i, 0)
      .set(Force, { x: ((i % 9) - 4) * 0.05, y: ((i % 5) - 2) * 0.05 })
      .set(Torque, { value: ((i % 7) - 3) * 0.001 });
    bodies.push(body);
  }
  return { worlds: [world], bodies };
}

/** Space Rocks shape: many small worlds, every body always awake and moving. */
function manyWorldsScene(worldCount: number, perWorld: number): Scene {
  const worlds = [];
  const bodies = [];
  for (let w = 0; w < worldCount; w++) {
    const world = new World();
    world.module(PhysicsModule, {
      gravity: { x: 0, y: 0 },
      fixedTimeStep: dt,
      enableSleep: false,
    });
    for (let i = 0; i < perWorld; i++) {
      bodies.push(driftBody(world, i, w));
    }
    worlds.push(world);
  }
  return { worlds, bodies };
}

/**
 * A pile under gravity inside a static box, sleep disabled so every body stays in the solver and
 * the move events. A quarter of the shapes report contact events, an eighth hit events, and every
 * other shape is detectable by a static sensor strip across the pile.
 */
function contactScene(): Scene {
  const world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: -10 }, fixedTimeStep: dt, enableSleep: false });
  const wall = (x: number, y: number, hx: number, hy: number) => {
    const body = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x, y });
    world.entity().add(ChildOf, body).set(Box, { hx, hy });
  };
  wall(0, -1, 26, 1);
  wall(-26, 30, 1, 31);
  wall(26, 30, 1, 31);
  // A kinematic paddle stirs the pile so contacts keep beginning and ending and hits keep firing.
  const paddle = world
    .entity()
    .set(Body, { type: BodyType.Kinematic })
    .set(Position, { x: 0, y: 10 })
    .set(AngularVelocity, { value: 0.8 });
  world.entity().add(ChildOf, paddle).set(Box, { hx: 12, hy: 0.5 });
  const sensor = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 6 });
  const sensorShape = world
    .entity()
    .add(ChildOf, sensor)
    .set(Box, { hx: 25, hy: 2 })
    .add(Sensor)
    .add(SensorEvents);

  const bodies: Entity[] = [];
  const eventShapes: Entity[] = [sensorShape];
  const hitShapes: Entity[] = [];
  const columns = 40;
  for (let i = 0; i < 1000; i++) {
    const column = i % columns;
    const row = Math.floor(i / columns);
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: -24 + column * 1.2 + (row % 2) * 0.3, y: 1 + row * 1.2 })
      .set(Rotation, { angle: (i % 9) * 0.05 })
      .set(LinearVelocity, { x: ((i % 7) - 3) * 0.5, y: 0 })
      .set(AngularVelocity, { value: ((i % 5) - 2) * 0.2 });
    const shape = world.entity().add(ChildOf, body);
    if (i % 3 === 0) {
      shape.set(Box, { hx: 0.45, hy: 0.4 });
    } else {
      shape.set(Circle, { radius: 0.45 });
    }
    if (i % 4 === 0) {
      shape.add(ContactEvents);
      eventShapes.push(shape);
    }
    if (i % 8 === 0) {
      shape.add(HitEvents);
      hitShapes.push(shape);
    }
    if (i % 2 === 0) {
      shape.add(Detectable);
    }
    bodies.push(body);
  }

  const digestStep = (h: number): number => {
    for (const shape of eventShapes) {
      const contact = shape.get(ContactEvents);
      if (contact !== undefined) {
        eventCounts.contactBegin += contact.begin.length;
        eventCounts.contactEnd += contact.end.length;
        for (const event of contact.begin) h = mix(h, event.other.eid);
        h = mix(h, 0x100000 + contact.begin.length);
        for (const event of contact.end) h = mix(h, event.other.eid);
        h = mix(h, 0x200000 + contact.end.length);
      }
      const sensorEvents = shape.get(SensorEvents);
      if (sensorEvents !== undefined) {
        eventCounts.sensorBegin += sensorEvents.begin.length;
        eventCounts.sensorEnd += sensorEvents.end.length;
        for (const event of sensorEvents.begin) h = mix(h, event.other.eid);
        for (const event of sensorEvents.end) h = mix(h, ~event.other.eid);
      }
    }
    for (const shape of hitShapes) {
      const hits = shape.get(HitEvents);
      if (hits !== undefined) {
        eventCounts.hits += hits.hits.length;
        for (const hit of hits.hits) {
          h = mix(h, hit.other.eid);
          h = mixFloat(h, hit.x);
          h = mixFloat(h, hit.y);
          h = mixFloat(h, hit.normalX);
          h = mixFloat(h, hit.normalY);
          h = mixFloat(h, hit.speed);
        }
      }
    }
    return h;
  };
  return { worlds: [world], bodies, digestStep };
}

function instrument(world: World, name: string, key: keyof typeof timers): void {
  const system = world.queries.find((query) => query.name === name);
  if (!(system instanceof System)) {
    return;
  }
  const original = system._run.bind(system);
  system._run = (now: number, delta: number) => {
    const start = performance.now();
    original(now, delta);
    timers[key] += performance.now() - start;
  };
}

function mix(h: number, value: number): number {
  scratch.setInt32(0, value, true);
  for (let i = 0; i < 4; i++) {
    h = Math.imul(h ^ scratch.getUint8(i), 16777619) >>> 0;
  }
  return h;
}

function mixFloat(h: number, value: number): number {
  scratch.setFloat64(0, value, true);
  for (let i = 0; i < 8; i++) {
    h = Math.imul(h ^ scratch.getUint8(i), 16777619) >>> 0;
  }
  return h;
}

/** Same byte hash as vecs bench/physics-pose-out.ts, continued from `h`. */
function digestBodies(h: number, bodies: Entity[]): number {
  for (const body of bodies) {
    const p = body.get(Position)!;
    const r = body.get(Rotation)!;
    const v = body.get(LinearVelocity)!;
    const w = body.get(AngularVelocity)!;
    for (const value of [p.x, p.y, r.angle, v.x, v.y, w.value]) {
      h = mixFloat(h, value);
    }
  }
  return h;
}

/**
 * Bytes allocated per step: heap growth across a window of steps with no GC in it. Shrinks the
 * window and retries when a scavenge lands inside it.
 */
async function measureAllocation(
  step: () => void
): Promise<{ bytesPerStep: number; window: number }> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) {
    return { bytesPerStep: -1, window: 0 };
  }
  let gcs = 0;
  const observer = new PerformanceObserver((list) => {
    gcs += list.getEntries().length;
  });
  observer.observe({ entryTypes: ["gc"] });
  let window = 64;
  try {
    while (window >= 2) {
      for (let i = 0; i < 8; i++) step();
      gc();
      await new Promise((resolve) => setTimeout(resolve, 50));
      gcs = 0;
      const before = v8.getHeapStatistics().used_heap_size;
      for (let i = 0; i < window; i++) step();
      const after = v8.getHeapStatistics().used_heap_size;
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (process.env.BENCH_DEBUG_ALLOC) console.error({ window, gcs, delta: after - before });
      if (gcs === 0) {
        return { bytesPerStep: Math.round((after - before) / window), window };
      }
      window >>= 1;
    }
  } finally {
    observer.disconnect();
  }
  return { bytesPerStep: -1, window: 0 };
}

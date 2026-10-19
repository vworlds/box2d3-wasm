// Engine benchmark: time b2World_Step on scenes modelled on Box2D's own benchmark suite
// (box2d/shared/benchmarks.c), sized for WebAssembly. Compares built packages, so a Box2D or
// toolchain update can be measured against the previous build.
//
//   node bench/engine.mjs                               # dist/, both flavours
//   node bench/engine.mjs <distA> [<distB> ...]         # compare builds (each a dist/ directory)
//
// Environment: BENCH_ROUNDS (default 5), BENCH_STEPS (default 300), BENCH_WARMUP (default 60),
// BENCH_FLAVOURS (default "deluxe compat"), BENCH_SCENES (default: all).
//
// Each (build, flavour, scene) measurement runs in a fresh process, and the builds alternate
// within a round, so thermal drift and JIT warm-up hit every build alike. The table shows the
// median ms per step over the rounds; spread is (max - min) / median. Only API that is the same
// in Box2D 3.1 and 3.2 is used, so older builds of this package run it unchanged.
import { spawnSync } from "node:child_process";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

const SCENES = {
  // 100-wide pyramid of unit boxes: 5050 bodies in one big island, sleep off.
  large_pyramid(b, w) {
    b.b2World_EnableSleeping(w, false);
    ground(b, w, 0, -1, 100, 1);
    pyramid(b, w, 100, 0.5, 0, 0, true);
  },
  // 10 x 10 small pyramids (base 10) on segment shelves: 5500 bodies in 100 islands, sleep off.
  many_pyramids(b, w) {
    b.b2World_EnableSleeping(w, false);
    const base = 10, extent = 0.5, rows = 10, cols = 10;
    const g = body(b, w, b.b2BodyType.b2_staticBody, 0, 0);
    const dy = 2 * extent * (base + 1), width = 2 * extent * cols * (base + 1);
    const sd = b.b2DefaultShapeDef();
    for (let i = 0; i < rows; i++) {
      const seg = new b.b2Segment();
      seg.point1.Set(-0.5 * width, i * dy);
      seg.point2.Set(0.5 * width, i * dy);
      b.b2CreateSegmentShape(g, sd, seg);
      seg.delete();
    }
    sd.delete();
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        pyramid(b, w, base, extent, -0.5 * width + j * (2 * extent * base + 2 * extent) + 2 * extent - 0.5, i * dy, false);
      }
    }
  },
  // 60 x 60 grid of circles linked by revolute joints, hanging from 7 static anchors.
  joint_grid(b, w) {
    b.b2World_EnableSleeping(w, false);
    const N = 60;
    const sd = b.b2DefaultShapeDef();
    sd.density = 1;
    sd.filter.categoryBits = 2;
    sd.filter.maskBits = ~2 >>> 0;
    const circle = new b.b2Circle();
    circle.radius = 0.4;
    const bodies = [];
    for (let k = 0; k < N; k++) {
      for (let i = 0; i < N; i++) {
        const anchor = k >= N / 2 - 3 && k <= N / 2 + 3 && i === 0;
        const id = body(b, w, anchor ? b.b2BodyType.b2_staticBody : b.b2BodyType.b2_dynamicBody, k, -i);
        b.b2CreateCircleShape(id, sd, circle);
        if (i > 0) revolute(b, w, bodies[bodies.length - 1], id, 0, -0.5, 0, 0.5);
        if (k > 0) revolute(b, w, bodies[bodies.length - N], id, 0.5, 0, -0.5, 0);
        bodies.push(id);
      }
    }
    circle.delete();
    sd.delete();
  },
  // A motorised box drum turning 2025 small boxes (sleep stays on, as upstream).
  tumbler(b, w) {
    const g = body(b, w, b.b2BodyType.b2_staticBody, 0, 0);
    const drum = body(b, w, b.b2BodyType.b2_dynamicBody, 0, 10);
    const sd = b.b2DefaultShapeDef();
    sd.density = 50;
    for (const [hx, hy, x, y] of [[0.5, 10, 10, 0], [0.5, 10, -10, 0], [10, 0.5, 0, 10], [10, 0.5, 0, -10]]) {
      const p = b.b2MakeOffsetBox(hx, hy, new b.b2Vec2(x, y), b.b2Rot_identity);
      b.b2CreatePolygonShape(drum, sd, p);
      p.delete();
    }
    sd.delete();
    const jd = b.b2DefaultRevoluteJointDef();
    jd.base.bodyIdA = g;
    jd.base.bodyIdB = drum;
    jd.base.localFrameA.p.Set(0, 10);
    jd.base.localFrameB.p.Set(0, 0);
    jd.motorSpeed = (Math.PI / 180) * 25;
    jd.maxMotorTorque = 1e8;
    jd.enableMotor = true;
    b.b2CreateRevoluteJoint(w, jd);
    jd.delete();
    const n = 45;
    const box = b.b2MakeBox(0.125, 0.125);
    const bsd = b.b2DefaultShapeDef();
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        b.b2CreatePolygonShape(body(b, w, b.b2BodyType.b2_dynamicBody, -0.2 * n + 0.4 * j, -0.2 * n + 10 + 0.4 * i), bsd, box);
      }
    }
    box.delete();
    bsd.delete();
  },
  // 2000 small circles drifting apart in zero gravity, never touching, sleep off: the per-body
  // integration and broadphase cost without contacts (the vecs pose-out workload).
  sparse_movers(b, w) {
    b.b2World_EnableSleeping(w, false);
    b.b2World_SetGravity(w, new b.b2Vec2(0, 0));
    const sd = b.b2DefaultShapeDef();
    const circle = new b.b2Circle();
    circle.radius = 0.25;
    const v = new b.b2Vec2(0, 0);
    for (let i = 0; i < 2000; i++) {
      const id = body(b, w, b.b2BodyType.b2_dynamicBody, (i % 50) * 10, Math.floor(i / 50) * 10);
      b.b2CreateCircleShape(id, sd, circle);
      v.Set(0.25 + (i % 13) * 0.01, -0.125);
      b.b2Body_SetLinearVelocity(id, v);
      b.b2Body_SetAngularVelocity(id, (i % 5) * 0.01);
    }
    v.delete();
    circle.delete();
    sd.delete();
  },
};

function body(b, w, type, x, y) {
  const d = b.b2DefaultBodyDef();
  d.type = type;
  d.position.Set(x, y);
  const id = b.b2CreateBody(w, d);
  d.delete();
  return id;
}
function ground(b, w, x, y, hx, hy) {
  const g = body(b, w, b.b2BodyType.b2_staticBody, x, y);
  const sd = b.b2DefaultShapeDef();
  const box = b.b2MakeBox(hx, hy);
  b.b2CreatePolygonShape(g, sd, box);
  box.delete();
  sd.delete();
}
function pyramid(b, w, base, extent, centerX, baseY, centered) {
  const sd = b.b2DefaultShapeDef();
  sd.density = 1;
  const box = b.b2MakeSquare(extent);
  for (let i = 0; i < base; i++) {
    const y = (2 * i + 1) * extent + baseY;
    for (let j = i; j < base; j++) {
      const x = centered
        ? (i + 1) * extent + 2 * (j - i) * extent - extent * base
        : (i + 1) * extent + 2 * (j - i) * extent + centerX;
      b.b2CreatePolygonShape(body(b, w, b.b2BodyType.b2_dynamicBody, x, y), sd, box);
    }
  }
  box.delete();
  sd.delete();
}
function revolute(b, w, a, c, ax, ay, bx, by) {
  const jd = b.b2DefaultRevoluteJointDef();
  jd.base.bodyIdA = a;
  jd.base.bodyIdB = c;
  jd.base.localFrameA.p.Set(ax, ay);
  jd.base.localFrameB.p.Set(bx, by);
  b.b2CreateRevoluteJoint(w, jd);
  jd.delete();
}

// ---- child: one measurement -------------------------------------------------------------------
if (process.argv[2] === "--child") {
  const [, , , dist, flavour, scene, steps, warmup] = process.argv;
  globalThis.navigator ??= {};
  globalThis.navigator.hardwareConcurrency ??= cpus().length;
  const factory = (await import(pathToFileURL(resolve(dist, flavour, `Box2D.${flavour}.mjs`)).href)).default;
  const b = await factory();
  const def = b.b2DefaultWorldDef();
  def.gravity.Set(0, -10);
  const w = b.b2CreateWorld(def);
  def.delete();
  const t0 = performance.now();
  SCENES[scene](b, w);
  const createMs = performance.now() - t0;
  for (let i = 0; i < Number(warmup); i++) b.b2World_Step(w, 1 / 60, 4);
  const t1 = performance.now();
  for (let i = 0; i < Number(steps); i++) b.b2World_Step(w, 1 / 60, 4);
  const msPerStep = (performance.now() - t1) / Number(steps);
  const awake = b.b2World_GetAwakeBodyCount(w);
  process.stdout.write(JSON.stringify({ msPerStep, createMs, awake }));
  process.exit(0);
}

// ---- parent: alternate builds, report medians -------------------------------------------------
const dists = process.argv.slice(2).length ? process.argv.slice(2).map((d) => resolve(d)) : [resolve(here, "../dist")];
const rounds = Number(process.env.BENCH_ROUNDS ?? 5);
const steps = Number(process.env.BENCH_STEPS ?? 300);
const warmup = Number(process.env.BENCH_WARMUP ?? 60);
const flavours = (process.env.BENCH_FLAVOURS ?? "deluxe compat").split(/\s+/).filter(Boolean);
const scenes = (process.env.BENCH_SCENES ?? Object.keys(SCENES).join(" ")).split(/\s+/).filter(Boolean);

// Labels are by path: b2GetVersion() is not a reliable name (the 3.1.1+18 pin already reports 3.2.0).
const labels = dists.map((_, i) => String.fromCharCode(65 + i));
console.log(`engine benchmark: ${rounds} rounds x ${steps} steps (+${warmup} warm-up), 1/60 s, 4 sub-steps, node ${process.version}`);
dists.forEach((d, i) => console.log(`  ${labels[i]}: ${d}`));

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const rows = [];
for (const flavour of flavours) {
  for (const scene of scenes) {
    const samples = dists.map(() => []);
    let awake = dists.map(() => 0);
    for (let r = 0; r < rounds; r++) {
      const order = r % 2 === 0 ? dists.map((_, i) => i) : dists.map((_, i) => dists.length - 1 - i);
      for (const i of order) {
        const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child", dists[i], flavour, scene, String(steps), String(warmup)], { encoding: "utf8" });
        if (res.status !== 0) throw new Error(`${scene} on ${dists[i]} failed:\n${res.stderr}`);
        const m = JSON.parse(res.stdout);
        samples[i].push(m.msPerStep);
        awake[i] = m.awake;
      }
    }
    const meds = samples.map(median);
    rows.push({ flavour, scene, meds, spread: samples.map((s, i) => (Math.max(...s) - Math.min(...s)) / meds[i]), awake });
    const cells = meds.map((m, i) => `${m.toFixed(3)} ms (±${((rows.at(-1).spread[i] * 100) / 2).toFixed(0)}%)`);
    const ratio = dists.length > 1 ? `  B/A ${(meds[1] / meds[0]).toFixed(2)}x` : "";
    console.log(`${flavour.padEnd(7)} ${scene.padEnd(14)} ${cells.join("  ")}${ratio}  awake ${awake.join("/")}`);
  }
}

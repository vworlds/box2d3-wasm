// Differential test: every value the b2x_ fast path exposes must equal (Object.is) what the
// embind API returns for the same thing at the same moment. Box2D only, no vecs.
//
//   node tests/fastpath-differential.mjs [deluxe|compat]   # dist/<flavour>/Box2D.<flavour>.mjs
//   node tests/fastpath-differential.mjs                   # dist/entry.mjs (picks a flavour itself)
//   BOX2D_ENTRY=<entry.mjs> node tests/fastpath-differential.mjs
//   BOX2D_FLAVOUR_FILE=<.../compat/Box2D.compat.mjs> node tests/fastpath-differential.mjs
// Needs a built dist/ (npm run build or npm run build:docker).
//
// Exits non-zero on the first mismatch. Prints the number of values compared.
import { cpus } from "node:os";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

globalThis.navigator ??= {};
globalThis.navigator.hardwareConcurrency ??= cpus().length;

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const flavourArg = process.argv[2];
if (flavourArg && flavourArg !== "deluxe" && flavourArg !== "compat") {
  throw new Error(`unknown flavour '${flavourArg}' (expected deluxe or compat)`);
}
if (flavourArg && !process.env.BOX2D_FLAVOUR_FILE && !process.env.BOX2D_ENTRY) {
  process.env.BOX2D_FLAVOUR_FILE = resolve(dist, flavourArg, `Box2D.${flavourArg}.mjs`);
}
const target = process.env.BOX2D_FLAVOUR_FILE ?? process.env.BOX2D_ENTRY ?? resolve(dist, "entry.mjs");
const { default: factory } = await import(pathToFileURL(resolve(target)).href);
const fastpathFile = process.env.BOX2D_FLAVOUR_FILE
  ? resolve(dirname(resolve(target)), "..", "fastpath.mjs")
  : resolve(dirname(resolve(target)), "fastpath.mjs");
const { createFastPath } = await import(pathToFileURL(fastpathFile).href);
const b = await factory();
const fp = createFastPath(b);
const L = fp.layout;
const VELOCITY = L.constants.exportVelocity;
const DYNAMIC_ONLY = L.constants.exportDynamicOnly;

let compared = 0;
function same(what, fast, slow) {
  compared++;
  if (!Object.is(fast, slow)) {
    console.error(`MISMATCH ${what}: fast=${fast} embind=${slow}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- scenes

function makeWorld(gravityY) {
  const def = b.b2DefaultWorldDef();
  def.gravity.x = 0;
  def.gravity.y = gravityY;
  def.enableSleep = false;
  const id = b.b2CreateWorld(def);
  def.delete();
  return id;
}

function addBody(worldId, type, x, y, angle, vx, vy, w, shape, opts = {}) {
  const bd = b.b2DefaultBodyDef();
  bd.type = type;
  bd.position.x = x;
  bd.position.y = y;
  bd.rotation = b.b2MakeRot(angle);
  bd.linearVelocity.x = vx;
  bd.linearVelocity.y = vy;
  bd.angularVelocity = w;
  const bodyId = b.b2CreateBody(worldId, bd);
  bd.delete();
  const sd = b.b2DefaultShapeDef();
  sd.enableContactEvents = !!opts.contact;
  sd.enableHitEvents = !!opts.hit;
  sd.enableSensorEvents = !!opts.sensorVisitor;
  if (opts.sensor) {
    sd.isSensor = true;
    sd.enableSensorEvents = true;
  }
  let shapeId;
  if (shape.box) {
    const poly = b.b2MakeBox(shape.box[0], shape.box[1]);
    shapeId = b.b2CreatePolygonShape(bodyId, sd, poly);
  } else {
    const c = new b.b2Circle();
    c.radius = shape.radius;
    shapeId = b.b2CreateCircleShape(bodyId, sd, c);
    c.delete();
  }
  sd.delete();
  return { bodyId, shapeId };
}

const { b2_dynamicBody: DYN, b2_kinematicBody: KIN, b2_staticBody: STA } = b.b2BodyType;

function driftWorld(n) {
  const worldId = makeWorld(0);
  const bodies = [];
  for (let i = 0; i < n; i++) {
    const type = i % 10 === 0 ? KIN : DYN;
    bodies.push(
      addBody(worldId, type, i * 10, (i % 7) * 10, (i % 11) * 0.1, 0.25 + (i % 13) * 0.01, -0.125, (i % 5) * 0.01, { radius: 0.25 })
    );
  }
  return { worldId, bodies };
}

function contactWorld() {
  const worldId = makeWorld(-10);
  const bodies = [];
  addBody(worldId, STA, 0, -1, 0, 0, 0, 0, { box: [26, 1] });
  addBody(worldId, STA, -26, 30, 0, 0, 0, 0, { box: [1, 31] });
  addBody(worldId, STA, 26, 30, 0, 0, 0, 0, { box: [1, 31] });
  addBody(worldId, STA, 0, 6, 0, 0, 0, 0, { box: [25, 2] }, { sensor: true });
  addBody(worldId, KIN, 0, 10, 0, 0, 0, 0.8, { box: [12, 0.5] }, { contact: true, hit: true });
  for (let i = 0; i < 600; i++) {
    const col = i % 40;
    const row = Math.floor(i / 40);
    bodies.push(
      addBody(
        worldId, DYN, -24 + col * 1.2 + (row % 2) * 0.3, 1 + row * 1.2, (i % 9) * 0.05,
        ((i % 7) - 3) * 0.5, 0, ((i % 5) - 2) * 0.2,
        i % 3 === 0 ? { box: [0.45, 0.4] } : { radius: 0.45 },
        { contact: i % 4 === 0, hit: i % 8 === 0, sensorVisitor: i % 2 === 0 }
      )
    );
  }
  return { worldId, bodies };
}

// ---------------------------------------------------------------- comparisons

function compareMoves(worldId, exporter, flags) {
  const world = fp.world(worldId);
  const count = exporter.exportMoves(world, flags);
  const events = b.b2World_GetBodyEvents(worldId);
  const moveCount = events.moveCount;
  same("moveCount", b._b2x_World_GetMoveCount(world), moveCount);
  const M = L.move;
  let r = 0;
  for (let i = 0; i < moveCount; i++) {
    const ev = events.GetMoveEvent(i);
    const bodyId = ev.bodyId;
    const type = b.b2Body_GetType(bodyId).value;
    if (flags & DYNAMIC_ONLY && type !== DYN.value) {
      ev.delete();
      continue;
    }
    const base = exporter.base + r * exporter.stride;
    const t = ev.transform;
    const p = t.p;
    const q = t.q;
    same("bodyIndex", fp.i32[base + (M.bodyIndex >> 2)], bodyId.index1);
    same("rev", fp.u32[base + (M.rev >> 2)], fp.rev(bodyId));
    same("x", fp.f32[base + (M.x >> 2)], p.x);
    same("y", fp.f32[base + (M.y >> 2)], p.y);
    same("c", fp.f32[base + (M.c >> 2)], q.c);
    same("s", fp.f32[base + (M.s >> 2)], q.s);
    same("angle", fp.f32[base + (M.angle >> 2)], q.GetAngle());
    const fl = fp.u32[base + (M.flags >> 2)];
    same("fellAsleep", (fl & L.constants.moveFellAsleep) !== 0, ev.fellAsleep);
    same("type", (fl >> L.constants.moveTypeShift) & 3, type);
    same("valid", (fl & L.constants.moveValid) !== 0, true);
    same("userData", fp.u32[base + (M.userData >> 2)], b._b2x_Body_GetUserData(bodyId.index1, fp.rev(bodyId)));
    if (flags & VELOCITY) {
      const v = b.b2Body_GetLinearVelocity(bodyId);
      same("vx", fp.f32[base + (M.vx >> 2)], v.x);
      same("vy", fp.f32[base + (M.vy >> 2)], v.y);
      v.delete();
      same("w", fp.f32[base + (M.w >> 2)], b.b2Body_GetAngularVelocity(bodyId));
    }
    ev.delete();
    r++;
  }
  events.delete();
  same("exported count", count, r);
  // The zero-copy span over Box2D's own array.
  const span = scratch;
  b._b2x_World_GetMoveEventSpan(world, span);
  const ptr = fp.u32[span >> 2];
  same("moveEvent span count", fp.i32[(span >> 2) + 1], moveCount);
  if (moveCount > 0) {
    const ev0 = events0(worldId);
    const E = L.moveEvent;
    same("moveEvent.x", fp.f32[(ptr + E.x) >> 2], ev0.x);
    same("moveEvent.body", fp.i32[(ptr + E.body) >> 2], ev0.index1);
    same("moveEvent.bodyGeneration", fp.u16[(ptr + E.bodyGeneration) >> 1], ev0.generation);
  }
}

function events0(worldId) {
  const events = b.b2World_GetBodyEvents(worldId);
  const ev = events.GetMoveEvent(0);
  const out = { x: ev.transform.p.x, index1: ev.bodyId.index1, generation: ev.bodyId.generation };
  ev.delete();
  events.delete();
  return out;
}

function compareContactEvents(worldId) {
  const world = fp.world(worldId);
  b._b2x_World_GetContactSpans(world, scratch);
  const S = L.contactSpans;
  const w = scratch >> 2;
  const events = b.b2World_GetContactEvents(worldId);
  same("beginCount", fp.i32[w + (S.beginCount >> 2)], events.beginCount);
  same("endCount", fp.i32[w + (S.endCount >> 2)], events.endCount);
  same("hitCount", fp.i32[w + (S.hitCount >> 2)], events.hitCount);
  const counts = { begin: events.beginCount, end: events.endCount, hit: events.hitCount, sensor: 0 };
  const beginPtr = fp.u32[w + (S.beginPtr >> 2)];
  const endPtr = fp.u32[w + (S.endPtr >> 2)];
  const hitPtr = fp.u32[w + (S.hitPtr >> 2)];
  for (let i = 0; i < events.beginCount; i++) {
    const e = events.GetBeginEvent(i);
    const at = beginPtr + i * L.contactBegin.size;
    same("begin.shapeA", fp.i32[(at + L.contactBegin.shapeA) >> 2], e.shapeIdA.index1);
    same("begin.shapeB", fp.i32[(at + L.contactBegin.shapeB) >> 2], e.shapeIdB.index1);
    same("begin.shapeAGeneration", fp.u16[(at + L.contactBegin.shapeAGeneration) >> 1], e.shapeIdA.generation);
    e.delete?.();
  }
  for (let i = 0; i < events.endCount; i++) {
    const e = events.GetEndEvent(i);
    const at = endPtr + i * L.contactEnd.size;
    same("end.shapeA", fp.i32[(at + L.contactEnd.shapeA) >> 2], e.shapeIdA.index1);
    same("end.shapeB", fp.i32[(at + L.contactEnd.shapeB) >> 2], e.shapeIdB.index1);
  }
  for (let i = 0; i < events.hitCount; i++) {
    const e = events.GetHitEvent(i);
    const at = hitPtr + i * L.contactHit.size;
    const H = L.contactHit;
    same("hit.shapeA", fp.i32[(at + H.shapeA) >> 2], e.shapeIdA.index1);
    same("hit.shapeB", fp.i32[(at + H.shapeB) >> 2], e.shapeIdB.index1);
    same("hit.pointX", fp.f32[(at + H.pointX) >> 2], e.point.x);
    same("hit.pointY", fp.f32[(at + H.pointY) >> 2], e.point.y);
    same("hit.normalX", fp.f32[(at + H.normalX) >> 2], e.normal.x);
    same("hit.normalY", fp.f32[(at + H.normalY) >> 2], e.normal.y);
    same("hit.speed", fp.f32[(at + H.approachSpeed) >> 2], e.approachSpeed);
    e.delete();
  }
  events.delete();

  b._b2x_World_GetSensorSpans(world, scratch);
  const T = L.sensorSpans;
  const sensors = b.b2World_GetSensorEvents(worldId);
  same("sensor beginCount", fp.i32[w + (T.beginCount >> 2)], sensors.beginCount);
  same("sensor endCount", fp.i32[w + (T.endCount >> 2)], sensors.endCount);
  const sb = fp.u32[w + (T.beginPtr >> 2)];
  const se = fp.u32[w + (T.endPtr >> 2)];
  for (let i = 0; i < sensors.beginCount; i++) {
    const e = sensors.GetBeginEvent(i);
    const at = sb + i * L.sensorBegin.size;
    same("sensorBegin.sensor", fp.i32[(at + L.sensorBegin.sensorShape) >> 2], e.sensorShapeId.index1);
    same("sensorBegin.visitor", fp.i32[(at + L.sensorBegin.visitorShape) >> 2], e.visitorShapeId.index1);
  }
  for (let i = 0; i < sensors.endCount; i++) {
    const e = sensors.GetEndEvent(i);
    const at = se + i * L.sensorEnd.size;
    same("sensorEnd.sensor", fp.i32[(at + L.sensorEnd.sensorShape) >> 2], e.sensorShapeId.index1);
    same("sensorEnd.visitor", fp.i32[(at + L.sensorEnd.visitorShape) >> 2], e.visitorShapeId.index1);
  }
  counts.sensor = sensors.beginCount + sensors.endCount;
  sensors.delete();
  return counts;
}

// ---------------------------------------------------------------- run

const scratch = fp.alloc(64);
const dt = 1 / 30;

// 1. Drift world: moves with and without velocity, dynamic-only, user data.
{
  const { worldId, bodies } = driftWorld(300);
  bodies.forEach(({ bodyId }, i) => b._b2x_Body_SetUserData(bodyId.index1, fp.rev(bodyId), 1000 + i * 7));
  const exporter = fp.createMoveExporter(4); // forces the grow-and-retry path
  for (let step = 0; step < 120; step++) {
    b._b2x_World_Step(fp.world(worldId), dt, 4);
    compareMoves(worldId, exporter, step % 3 === 0 ? 0 : VELOCITY);
    compareMoves(worldId, exporter, VELOCITY | DYNAMIC_ONLY);
    if (step === 60) {
      // Force memory growth mid-run, then keep going: views must follow.
      const grown = fp.memory.buffer.byteLength;
      const big = b._malloc(64 << 20);
      same("memory grew", fp.memory.buffer.byteLength > grown, true);
      for (let i = 0; i < 200; i++) addBody(worldId, DYN, 5000 + i, 0, 0, 1, 0, 0.1, { radius: 0.3 });
      b._free(big);
    }
  }
  for (const { bodyId } of bodies.slice(0, 5)) {
    same("user data round trip", b._b2x_Body_GetUserData(bodyId.index1, fp.rev(bodyId)), 1000 + bodies.findIndex((x) => x.bodyId.index1 === bodyId.index1) * 7);
  }
  exporter.dispose();
}

// 2. Contact world: moves plus contact/hit/sensor spans every step.
let totals = { begin: 0, end: 0, hit: 0, sensor: 0 };
{
  const { worldId } = contactWorld();
  const exporter = fp.createMoveExporter(64);
  for (let step = 0; step < 240; step++) {
    b._b2x_World_Step(fp.world(worldId), dt, 4);
    compareMoves(worldId, exporter, VELOCITY);
    const c = compareContactEvents(worldId);
    totals.begin += c.begin;
    totals.end += c.end;
    totals.hit += c.hit;
    totals.sensor += c.sensor;
  }
  exporter.dispose();
}

// 3. Fused step+export equals step then export: two identical worlds, bitwise.
{
  const a = driftWorld(200);
  const c = driftWorld(200);
  const ea = fp.createMoveExporter(256);
  const ec = fp.createMoveExporter(256);
  for (let step = 0; step < 60; step++) {
    b._b2x_World_Step(fp.world(a.worldId), dt, 4);
    const na = ea.exportMoves(fp.world(a.worldId), VELOCITY);
    const nc = ec.stepAndExportMoves(fp.world(c.worldId), dt, 4, VELOCITY);
    same("fused count", nc, na);
    for (let k = 0; k < na * ea.stride; k++) {
      if (k % ea.stride === L.move.rev >> 2 || k % ea.stride === L.move.bodyIndex >> 2) continue; // different worlds
      same("fused record word", fp.u32[ec.base + k], fp.u32[ea.base + k]);
    }
  }
}

// 4. The embind world step and the raw step produce identical worlds.
{
  const a = contactWorld();
  const c = contactWorld();
  const ea = fp.createMoveExporter(1024);
  const ec = fp.createMoveExporter(1024);
  for (let step = 0; step < 120; step++) {
    b.b2World_Step(a.worldId, dt, 4);
    b._b2x_World_Step(fp.world(c.worldId), dt, 4);
    const na = ea.exportMoves(fp.world(a.worldId), VELOCITY);
    const nc = ec.exportMoves(fp.world(c.worldId), VELOCITY);
    same("raw vs embind step count", nc, na);
    for (let k = 0; k < na * ea.stride; k++) {
      if (k % ea.stride === L.move.rev >> 2) continue;
      same("raw vs embind step word", fp.u32[ec.base + k], fp.u32[ea.base + k]);
    }
  }
}

// 5. Generated b2x_Body_* getters and the composites equal their embind twins, every body.
{
  const { worldId, bodies } = contactWorld();
  const out = fp.alloc(64);
  const o = out >> 2;
  const vec = new b.b2Vec2();
  for (let step = 0; step < 90; step++) {
    b._b2x_World_Step(fp.world(worldId), dt, 4);
    if (step % 10 !== 9) continue;
    for (const { bodyId, shapeId } of bodies) {
      const i = bodyId.index1;
      const r = fp.rev(bodyId);
      const v2 = (name, fastFn, slow, fields = ["x", "y"]) => {
        fastFn();
        fp.sync();
        fields.forEach((f, k) => same(`${name}.${f}`, fp.f32[o + k], slow[f]));
        slow.delete?.();
      };
      v2("GetPosition", () => b._b2x_Body_GetPosition(i, r, out), b.b2Body_GetPosition(bodyId));
      v2("GetRotation", () => b._b2x_Body_GetRotation(i, r, out), b.b2Body_GetRotation(bodyId), ["c", "s"]);
      v2("GetLinearVelocity", () => b._b2x_Body_GetLinearVelocity(i, r, out), b.b2Body_GetLinearVelocity(bodyId));
      v2("GetLocalCenter", () => b._b2x_Body_GetLocalCenter(i, r, out), b.b2Body_GetLocalCenter(bodyId));
      v2("GetWorldCenter", () => b._b2x_Body_GetWorldCenter(i, r, out), b.b2Body_GetWorldCenter(bodyId));
      vec.Set(1.25, -0.5);
      v2("GetWorldPoint", () => b._b2x_Body_GetWorldPoint(i, r, 1.25, -0.5, out), b.b2Body_GetWorldPoint(bodyId, vec));
      v2("GetLocalPoint", () => b._b2x_Body_GetLocalPoint(i, r, 1.25, -0.5, out), b.b2Body_GetLocalPoint(bodyId, vec));
      v2("GetWorldPointVelocity", () => b._b2x_Body_GetWorldPointVelocity(i, r, 1.25, -0.5, out), b.b2Body_GetWorldPointVelocity(bodyId, vec));
      const t = b.b2Body_GetTransform(bodyId);
      b._b2x_Body_GetTransform(i, r, out);
      same("GetTransform.px", fp.f32[o], t.p.x);
      same("GetTransform.qs", fp.f32[o + 3], t.q.s);
      t.delete();
      const aabb = b.b2Body_ComputeBounds(bodyId);
      b._b2x_Body_ComputeBounds(i, r, out);
      same("ComputeBounds.lowerX", fp.f32[o], aabb.lowerBound.x);
      same("ComputeBounds.upperY", fp.f32[o + 3], aabb.upperBound.y);
      aabb.delete();
      const md = b.b2Body_GetMassData(bodyId);
      b._b2x_Body_GetMassData(i, r, out);
      same("GetMassData.mass", fp.f32[o], md.mass);
      same("GetMassData.centerX", fp.f32[o + 1], md.center.x);
      same("GetMassData.inertia", fp.f32[o + 3], md.rotationalInertia);
      md.delete();
      for (const name of ["GetAngularVelocity", "GetMass", "GetRotationalInertia", "GetLinearDamping", "GetAngularDamping", "GetGravityScale", "GetSleepThreshold", "GetShapeCount", "GetJointCount"]) {
        same(name, b[`_b2x_Body_${name}`](i, r), b[`b2Body_${name}`](bodyId));
      }
      for (const name of ["IsAwake", "IsEnabled", "IsBullet", "IsSleepingEnabled", "IsValid"]) {
        same(name, b[`_b2x_Body_${name}`](i, r) !== 0, b[`b2Body_${name}`](bodyId));
      }
      same("GetType", b._b2x_Body_GetType(i, r), b.b2Body_GetType(bodyId).value);
      same("GetWorld", b._b2x_Body_GetWorld(i, r), fp.world(b.b2Body_GetWorld(bodyId)));
      same("GetShapes", b._b2x_Body_GetShapes(i, r, out, 4), 1);
      fp.sync();
      same("GetShapes[0].index1", fp.i32[o], shapeId.index1);
      same("GetShapes[0].rev", fp.i32[o + 1], fp.rev(shapeId));
      // Composites: pose and motion.
      b._b2x_Body_GetPose(i, r, out);
      fp.sync();
      const P = L.pose;
      const q = b.b2Body_GetRotation(bodyId);
      same("GetPose.angle", fp.f32[(out + P.angle) >> 2], q.GetAngle());
      same("GetPose.s", fp.f32[(out + P.s) >> 2], q.s);
      q.delete();
      b._b2x_Body_GetMotion(i, r, out);
      fp.sync();
      const M = L.motion;
      const lv = b.b2Body_GetLinearVelocity(bodyId);
      same("GetMotion.awake", fp.i32[(out + M.awake) >> 2] !== 0, b.b2Body_IsAwake(bodyId));
      same("GetMotion.vx", fp.f32[(out + M.vx) >> 2], lv.x);
      same("GetMotion.vy", fp.f32[(out + M.vy) >> 2], lv.y);
      lv.delete();
      same("GetMotion.w", fp.f32[(out + M.w) >> 2], b.b2Body_GetAngularVelocity(bodyId));
      same("GetMotion.mass", fp.f32[(out + M.mass) >> 2], b.b2Body_GetMass(bodyId));
      same("GetMotion.gravityScale", fp.f32[(out + M.gravityScale) >> 2], b.b2Body_GetGravityScale(bodyId));
      const lc = b.b2Body_GetLocalCenter(bodyId);
      same("GetMotion.localCenterX", fp.f32[(out + M.localCenterX) >> 2], lc.x);
      lc.delete();
    }
  }
}

// 6. Setters: twin worlds, one driven through embind, one through b2x_, same double inputs
//    (so f32 argument rounding is exercised); full state compared bitwise every step.
{
  const A = contactWorld();
  const B = contactWorld();
  const ea = fp.createMoveExporter(1024);
  const eb = fp.createMoveExporter(1024);
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32 - 0.5) * 7.3;
  const vec = new b.b2Vec2();
  const vec2 = new b.b2Vec2();
  for (let step = 0; step < 150; step++) {
    for (let k = 0; k < A.bodies.length; k += 7) {
      const a = A.bodies[k].bodyId;
      const c = B.bodies[k].bodyId;
      const i = c.index1;
      const r = fp.rev(c);
      const x = rnd(), y = rnd(), z = rnd(), w = rnd();
      switch ((step + k) % 12) {
        case 0: { // vecs pose-in Position: SetTransform(id, {x, y}, GetRotation(id))
          const rot = b.b2Body_GetRotation(a); vec.Set(x, y); b.b2Body_SetTransform(a, vec, rot); rot.delete();
          b._b2x_Body_SetPosition(i, r, x, y); break; }
        case 1: { // vecs pose-in Rotation: SetTransform(id, GetPosition(id), b2MakeRot(angle))
          const pos = b.b2Body_GetPosition(a); const rot = b.b2MakeRot(z); b.b2Body_SetTransform(a, pos, rot); rot.delete(); pos.delete();
          b._b2x_Body_SetAngle(i, r, z); break; }
        case 2: vec.Set(x, y); b.b2Body_SetLinearVelocity(a, vec); b._b2x_Body_SetLinearVelocity(i, r, x, y); break;
        case 3: b.b2Body_SetAngularVelocity(a, z); b._b2x_Body_SetAngularVelocity(i, r, z); break;
        case 4: vec.Set(x * 10, y * 10); b.b2Body_ApplyForceToCenter(a, vec, true); b._b2x_Body_ApplyForceToCenter(i, r, x * 10, y * 10, 1); break;
        case 5: b.b2Body_ApplyTorque(a, z, true); b._b2x_Body_ApplyTorque(i, r, z, 1); break;
        case 6: vec.Set(x, y); b.b2Body_ApplyLinearImpulseToCenter(a, vec, true); b._b2x_Body_ApplyLinearImpulseToCenter(i, r, x, y, 1); break;
        case 7: b.b2Body_ApplyAngularImpulse(a, z * 0.1, true); b._b2x_Body_ApplyAngularImpulse(i, r, z * 0.1, 1); break;
        case 8: { vec.Set(x, y); const wp = b.b2Body_GetWorldCenter(a); vec2.Set(wp.x + w * 0.1, wp.y); wp.delete();
          b.b2Body_ApplyForce(a, vec, vec2, true); b._b2x_Body_ApplyForce(i, r, x, y, vec2.x, vec2.y, 1); break; }
        case 9: b.b2Body_SetLinearDamping(a, Math.abs(z) * 0.01); b._b2x_Body_SetLinearDamping(i, r, Math.abs(z) * 0.01); break;
        case 10: b.b2Body_SetGravityScale(a, 1 + z * 0.01); b._b2x_Body_SetGravityScale(i, r, 1 + z * 0.01); break;
        case 11: { const t = { linearX: false, linearY: false, angularZ: (step & 1) === 1 };
          b.b2Body_SetAwake(a, true); b._b2x_Body_SetAwake(i, r, 1); void t; break; }
      }
    }
    b._b2x_World_Step(fp.world(A.worldId), dt, 4);
    b._b2x_World_Step(fp.world(B.worldId), dt, 4);
    const na = ea.exportMoves(fp.world(A.worldId), VELOCITY);
    const nb = eb.exportMoves(fp.world(B.worldId), VELOCITY);
    same("setter twin count", nb, na);
    for (let k = 0; k < na * ea.stride; k++) {
      if (k % ea.stride === L.move.rev >> 2) continue;
      same("setter twin word", fp.u32[eb.base + k], fp.u32[ea.base + k]);
    }
  }
}

if (totals.begin === 0 || totals.end === 0 || totals.hit === 0 || totals.sensor === 0) {
  console.error("contact scene produced no events of some kind; the event comparison is vacuous", totals);
  process.exit(1);
}
console.log(
  `FASTPATH_DIFFERENTIAL ok: ${compared} values compared; contact begins ${totals.begin}, ends ${totals.end}, hits ${totals.hit}, sensor events ${totals.sensor}; shared memory ${fp.memory.buffer instanceof SharedArrayBuffer}`
);

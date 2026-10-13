// Independent stock-vs-fork differential: hashes every body's state and every event at every step.
//   node diff.mjs <es-dir> <deluxe|compat> <embind|fast> <out.json>
// <es-dir> holds <flavour>/Box2D.<flavour>.mjs (and fastpath.mjs for `fast`): dist/ of this
// repository, or node_modules/box2d3-wasm/build/dist/es for the stock package.
// embind: only the upstream embind API (runs on stock and fork).
// fast:   step, inputs, state and events through the fork's b2x_ exports, profile timers off; every
//         fast value is additionally compared in-process with its embind twin.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const [pkgDir, flavour, mode, outFile] = process.argv.slice(2);
const es = resolve(pkgDir);
const factory = (await import(pathToFileURL(`${es}/${flavour}/Box2D.${flavour}.mjs`).href)).default;
const b2 = await factory();
const FAST = mode === "fast";
let fp, scratch, mover, spans;
if (FAST) {
  const { createFastPath } = await import(pathToFileURL(`${es}/fastpath.mjs`).href);
  fp = createFastPath(b2);
  fp.setProfileTimers(false);
  scratch = fp.alloc(64);
  spans = fp.alloc(64);
  mover = fp.createMoveExporter(4); // tiny on purpose: forces the grow path
}

// ---------------------------------------------------------------- deterministic helpers
let seed = 1;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const range = (a, b) => a + (b - a) * rnd();
const pick = (n) => Math.floor(rnd() * n);

class Recorder {
  constructor() {
    this.f = new Float32Array(1 << 16);
    this.i = new Int32Array(this.f.buffer);
    this.n = 0;
    this.sha = createHash("sha256");
    this.steps = [];
    this.values = 0;
  }
  room() {
    if (this.n >= this.f.length) {
      const f = new Float32Array(this.f.length * 2);
      f.set(this.f);
      this.f = f;
      this.i = new Int32Array(f.buffer);
    }
  }
  F(v) { this.room(); this.f[this.n++] = v; }
  I(v) { this.room(); this.i[this.n++] = v | 0; }
  endStep() {
    const bytes = new Uint8Array(this.f.buffer, 0, this.n * 4);
    this.sha.update(bytes);
    let h = 0x811c9dc5;
    for (let k = 0; k < this.n; k++) h = Math.imul(h ^ this.i[k], 0x01000193);
    this.steps.push(h >>> 0);
    this.values += this.n;
    this.n = 0;
  }
}

let mismatches = 0;
function same(a, b, what) {
  if (!Object.is(Math.fround(a), Math.fround(b)) && mismatches++ < 10) console.error(`IN-PROCESS MISMATCH ${what}: fast=${a} embind=${b}`);
}

// ---------------------------------------------------------------- world wrapper
const vec = new b2.b2Vec2();
const V = (x, y) => vec.Set(x, y);

function makeWorld(gx, gy, sleep = true) {
  const def = b2.b2DefaultWorldDef();
  const g = def.gravity; g.Set(gx, gy); def.gravity = g;
  def.enableSleep = sleep;
  const id = b2.b2CreateWorld(def);
  def.delete();
  return { id, w: FAST ? fp.world(id) : 0, bodies: [], shapes: new Map(), joints: [] };
}

function addBody(W, type, x, y, angle = 0, opts = {}) {
  const bd = b2.b2DefaultBodyDef();
  bd.type = type;
  const p = bd.position; p.Set(x, y); bd.position = p;
  const r = b2.b2MakeRot(angle); bd.rotation = r; r.delete?.();
  if (opts.bullet) bd.isBullet = true;
  if (opts.vx !== undefined) { const v = bd.linearVelocity; v.Set(opts.vx, opts.vy); bd.linearVelocity = v; }
  if (opts.w !== undefined) bd.angularVelocity = opts.w;
  if (opts.linearDamping !== undefined) bd.linearDamping = opts.linearDamping;
  if (opts.sleepThreshold !== undefined) bd.sleepThreshold = opts.sleepThreshold;
  if (opts.enableSleep !== undefined) bd.enableSleep = opts.enableSleep;
  const id = b2.b2CreateBody(W.id, bd);
  bd.delete();
  const body = { id, index1: id.index1, rev: id.world0 | (id.generation << 16), alive: true };
  W.bodies.push(body);
  return body;
}

function shapeDef(o = {}) {
  const sd = b2.b2DefaultShapeDef();
  sd.density = o.density ?? 1;
  const m = sd.material;
  m.friction = o.friction ?? 0.6;
  m.restitution = o.restitution ?? 0;
  if (o.rolling !== undefined) m.rollingResistance = o.rolling;
  sd.material = m;
  sd.isSensor = !!o.sensor;
  sd.enableSensorEvents = o.sensorEvents ?? true;
  sd.enableContactEvents = o.contactEvents ?? true;
  sd.enableHitEvents = !!o.hit;
  return sd;
}
function addBox(body, hx, hy, o) {
  const sd = shapeDef(o); const poly = o?.round ? b2.b2MakeRoundedBox(hx, hy, o.round) : b2.b2MakeBox(hx, hy);
  const s = b2.b2CreatePolygonShape(body.id, sd, poly); sd.delete(); poly.delete(); return s;
}
function addCircle(body, radius, o) {
  const sd = shapeDef(o); const c = new b2.b2Circle(); const ctr = c.center; ctr.Set(0, 0); c.center = ctr; c.radius = radius;
  const s = b2.b2CreateCircleShape(body.id, sd, c); sd.delete(); c.delete(); return s;
}
function addCapsule(body, half, radius, o) {
  const sd = shapeDef(o); const c = new b2.b2Capsule();
  let q = c.center1; q.Set(-half, 0); c.center1 = q; q = c.center2; q.Set(half, 0); c.center2 = q; c.radius = radius;
  const s = b2.b2CreateCapsuleShape(body.id, sd, c); sd.delete(); c.delete(); return s;
}
function randomShape(body, scale, o) {
  const k = pick(4);
  if (k === 0) return addBox(body, range(0.2, 0.6) * scale, range(0.2, 0.6) * scale, o);
  if (k === 1) return addCircle(body, range(0.2, 0.5) * scale, o);
  if (k === 2) return addCapsule(body, range(0.2, 0.5) * scale, range(0.15, 0.3) * scale, o);
  return addBox(body, range(0.25, 0.5) * scale, range(0.25, 0.5) * scale, { ...o, round: 0.08 * scale });
}
function jointBase(def, a, b, ax, ay, bx, by, collide = false) {
  const base = def.base;
  base.bodyIdA = a.id; base.bodyIdB = b.id; base.collideConnected = collide;
  let f = base.localFrameA; let p = f.p; p.Set(ax, ay); f.p = p; base.localFrameA = f;
  f = base.localFrameB; p = f.p; p.Set(bx, by); f.p = p; base.localFrameB = f;
  def.base = base;
}
function destroyBody(W, body) {
  b2.b2DestroyBody(body.id);
  body.alive = false;
}

// ---- inputs: embind in embind mode, b2x in fast mode, same doubles
const In = {
  impulse(B, x, y) { if (process.env?.PERTURB && !In.done) { In.done = true; x = new Float32Array([x])[0]; const u = new Uint32Array(new Float32Array([x]).buffer); u[0] += Number(process.env.PERTURB); x = new Float32Array(u.buffer)[0]; } FAST ? b2._b2x_Body_ApplyLinearImpulseToCenter(B.index1, B.rev, x, y, 1) : b2.b2Body_ApplyLinearImpulseToCenter(B.id, V(x, y), true); },
  force(B, x, y) { FAST ? b2._b2x_Body_ApplyForceToCenter(B.index1, B.rev, x, y, 1) : b2.b2Body_ApplyForceToCenter(B.id, V(x, y), true); },
  torque(B, t) { FAST ? b2._b2x_Body_ApplyTorque(B.index1, B.rev, t, 1) : b2.b2Body_ApplyTorque(B.id, t, true); },
  angImpulse(B, t) { FAST ? b2._b2x_Body_ApplyAngularImpulse(B.index1, B.rev, t, 1) : b2.b2Body_ApplyAngularImpulse(B.id, t, true); },
  vel(B, x, y) { FAST ? b2._b2x_Body_SetLinearVelocity(B.index1, B.rev, x, y) : b2.b2Body_SetLinearVelocity(B.id, V(x, y)); },
  angVel(B, w) { FAST ? b2._b2x_Body_SetAngularVelocity(B.index1, B.rev, w) : b2.b2Body_SetAngularVelocity(B.id, w); },
  awake(B, on) { FAST ? b2._b2x_Body_SetAwake(B.index1, B.rev, on ? 1 : 0) : b2.b2Body_SetAwake(B.id, on); },
  position(B, x, y) {
    if (FAST) return b2._b2x_Body_SetPosition(B.index1, B.rev, x, y);
    const q = b2.b2Body_GetRotation(B.id); b2.b2Body_SetTransform(B.id, V(x, y), q); q.delete?.();
  },
  angle(B, a) {
    if (FAST) return b2._b2x_Body_SetAngle(B.index1, B.rev, a);
    const p = b2.b2Body_GetPosition(B.id); const q = b2.b2MakeRot(a); b2.b2Body_SetTransform(B.id, p, q); p.delete?.(); q.delete?.();
  },
  type(B, t) { FAST ? b2._b2x_Body_SetType(B.index1, B.rev, t.value) : b2.b2Body_SetType(B.id, t); },
  gravityScale(B, s) { FAST ? b2._b2x_Body_SetGravityScale(B.index1, B.rev, s) : b2.b2Body_SetGravityScale(B.id, s); },
};

function step(W, dt, sub) {
  if (FAST) b2._b2x_World_Step(W.w, dt, sub); else b2.b2World_Step(W.id, dt, sub);
}

// ---- record everything observable after a step
function record(W, R) {
  // 1. every live body: position, rotation, velocities, awake
  if (FAST) fp.sync();
  for (const B of W.bodies) {
    if (!B.alive) continue;
    R.I(B.index1); R.I(B.rev);
    if (FAST) {
      const m = b2; const o = scratch >> 2;
      m._b2x_Body_GetTransform(B.index1, B.rev, scratch);
      const f = fp.f32; const x = f[o], y = f[o + 1], c = f[o + 2], s = f[o + 3];
      m._b2x_Body_GetLinearVelocity(B.index1, B.rev, scratch);
      const vx = f[o], vy = f[o + 1];
      const w = m._b2x_Body_GetAngularVelocity(B.index1, B.rev);
      const awake = m._b2x_Body_IsAwake(B.index1, B.rev);
      R.F(x); R.F(y); R.F(c); R.F(s); R.F(vx); R.F(vy); R.F(w); R.I(awake);
      // embind twins
      const p = m.b2Body_GetPosition(B.id), q = m.b2Body_GetRotation(B.id), v = m.b2Body_GetLinearVelocity(B.id);
      same(x, p.x, "x"); same(y, p.y, "y"); same(c, q.c, "c"); same(s, q.s, "s"); same(vx, v.x, "vx"); same(vy, v.y, "vy");
      same(w, m.b2Body_GetAngularVelocity(B.id), "w");
      if ((awake !== 0) !== m.b2Body_IsAwake(B.id)) mismatches++;
      m._b2x_Body_GetPose(B.index1, B.rev, scratch);
      same(fp.f32[o + 4], q.GetAngle(), "pose.angle"); same(fp.f32[o], p.x, "pose.x");
      p.delete?.(); q.delete?.(); v.delete?.();
    } else {
      const p = b2.b2Body_GetPosition(B.id), q = b2.b2Body_GetRotation(B.id), v = b2.b2Body_GetLinearVelocity(B.id);
      R.F(p.x); R.F(p.y); R.F(q.c); R.F(q.s); R.F(v.x); R.F(v.y); R.F(b2.b2Body_GetAngularVelocity(B.id)); R.I(b2.b2Body_IsAwake(B.id) ? 1 : 0);
      p.delete?.(); q.delete?.(); v.delete?.();
    }
  }
  // 2. move events
  if (FAST) {
    const n = mover.exportMoves(W.w, fp.layout.constants.exportVelocity);
    const L = fp.layout.move, C = fp.layout.constants; const { i32, u32, f32 } = fp;
    const ev = b2.b2World_GetBodyEvents(W.id);
    if (ev.moveCount !== n) { mismatches++; console.error("move count", n, ev.moveCount); }
    R.I(n);
    for (let k = 0, at = mover.ptr; k < n; k++, at += L.size) {
      const idx = i32[(at + L.bodyIndex) >> 2], rev = u32[(at + L.rev) >> 2], flags = u32[(at + L.flags) >> 2];
      const x = f32[(at + L.x) >> 2], y = f32[(at + L.y) >> 2], c = f32[(at + L.c) >> 2], s = f32[(at + L.s) >> 2];
      R.I(idx); R.F(x); R.F(y); R.F(c); R.F(s); R.I(flags & C.moveFellAsleep ? 1 : 0);
      const e = ev.GetMoveEvent(k); const id = e.bodyId, t = e.transform, p = t.p, q = t.q;
      if (id.index1 !== idx || (id.world0 | (id.generation << 16)) !== rev || e.fellAsleep !== !!(flags & C.moveFellAsleep)) mismatches++;
      same(x, p.x, "move.x"); same(y, p.y, "move.y"); same(c, q.c, "move.c"); same(s, q.s, "move.s");
      same(f32[(at + L.angle) >> 2], q.GetAngle(), "move.angle");
      if (flags & C.moveValid) {
        const v = b2.b2Body_GetLinearVelocity(id);
        same(f32[(at + L.vx) >> 2], v.x, "move.vx"); same(f32[(at + L.vy) >> 2], v.y, "move.vy");
        same(f32[(at + L.w) >> 2], b2.b2Body_GetAngularVelocity(id), "move.w"); v.delete?.();
      }
      e.delete?.();
    }
    ev.delete?.();
  } else {
    const ev = b2.b2World_GetBodyEvents(W.id); const n = ev.moveCount;
    R.I(n);
    for (let k = 0; k < n; k++) {
      const e = ev.GetMoveEvent(k); const id = e.bodyId, t = e.transform, p = t.p, q = t.q;
      R.I(id.index1); R.F(p.x); R.F(p.y); R.F(q.c); R.F(q.s); R.I(e.fellAsleep ? 1 : 0);
      e.delete?.();
    }
    ev.delete?.();
  }
  // 3. contact events
  if (FAST) {
    b2._b2x_World_GetContactSpans(W.w, spans); fp.sync();
    const S = fp.layout.contactSpans, Bg = fp.layout.contactBegin, En = fp.layout.contactEnd, H = fp.layout.contactHit; const { i32, u32, f32 } = fp;
    const nb = i32[(spans + S.beginCount) >> 2], ne = i32[(spans + S.endCount) >> 2], nh = i32[(spans + S.hitCount) >> 2];
    R.I(nb); R.I(ne); R.I(nh);
    for (let k = 0, at = u32[(spans + S.beginPtr) >> 2]; k < nb; k++, at += Bg.size) { R.I(i32[(at + Bg.shapeA) >> 2]); R.I(i32[(at + Bg.shapeB) >> 2]); }
    for (let k = 0, at = u32[(spans + S.endPtr) >> 2]; k < ne; k++, at += En.size) { R.I(i32[(at + En.shapeA) >> 2]); R.I(i32[(at + En.shapeB) >> 2]); }
    for (let k = 0, at = u32[(spans + S.hitPtr) >> 2]; k < nh; k++, at += H.size) {
      R.I(i32[(at + H.shapeA) >> 2]); R.I(i32[(at + H.shapeB) >> 2]);
      R.F(f32[(at + H.pointX) >> 2]); R.F(f32[(at + H.pointY) >> 2]); R.F(f32[(at + H.normalX) >> 2]); R.F(f32[(at + H.normalY) >> 2]); R.F(f32[(at + H.approachSpeed) >> 2]);
    }
    b2._b2x_World_GetSensorSpans(W.w, spans);
    const SS = fp.layout.sensorSpans, SB = fp.layout.sensorBegin, SE = fp.layout.sensorEnd;
    const sb = i32[(spans + SS.beginCount) >> 2], se = i32[(spans + SS.endCount) >> 2];
    R.I(sb); R.I(se);
    for (let k = 0, at = u32[(spans + SS.beginPtr) >> 2]; k < sb; k++, at += SB.size) { R.I(i32[(at + SB.sensorShape) >> 2]); R.I(i32[(at + SB.visitorShape) >> 2]); }
    for (let k = 0, at = u32[(spans + SS.endPtr) >> 2]; k < se; k++, at += SE.size) { R.I(i32[(at + SE.sensorShape) >> 2]); R.I(i32[(at + SE.visitorShape) >> 2]); }
    stats.contacts += nb; stats.hits += nh; stats.sensor += sb;
  } else {
    const ce = b2.b2World_GetContactEvents(W.id);
    const nb = ce.beginCount, ne = ce.endCount, nh = ce.hitCount;
    R.I(nb); R.I(ne); R.I(nh);
    for (let k = 0; k < nb; k++) { const e = ce.GetBeginEvent(k); const a = e.shapeIdA, b = e.shapeIdB; R.I(a.index1); R.I(b.index1); e.delete?.(); }
    for (let k = 0; k < ne; k++) { const e = ce.GetEndEvent(k); const a = e.shapeIdA, b = e.shapeIdB; R.I(a.index1); R.I(b.index1); e.delete?.(); }
    for (let k = 0; k < nh; k++) {
      const e = ce.GetHitEvent(k); const a = e.shapeIdA, b = e.shapeIdB, p = e.point, n = e.normal;
      R.I(a.index1); R.I(b.index1); R.F(p.x); R.F(p.y); R.F(n.x); R.F(n.y); R.F(e.approachSpeed);
      e.delete?.();
    }
    ce.delete?.();
    const se = b2.b2World_GetSensorEvents(W.id); const sb = se.beginCount, sn = se.endCount;
    R.I(sb); R.I(sn);
    for (let k = 0; k < sb; k++) { const e = se.GetBeginEvent(k); const a = e.sensorShapeId, b = e.visitorShapeId; R.I(a.index1); R.I(b.index1); e.delete?.(); }
    for (let k = 0; k < sn; k++) { const e = se.GetEndEvent(k); const a = e.sensorShapeId, b = e.visitorShapeId; R.I(a.index1); R.I(b.index1); e.delete?.(); }
    se.delete?.();
    stats.contacts += nb; stats.hits += nh; stats.sensor += sb;
  }
  const awake = b2.b2World_GetAwakeBodyCount(W.id);
  R.I(awake);
  stats.minAwake = Math.min(stats.minAwake, awake); stats.maxAwake = Math.max(stats.maxAwake, awake);
}

let stats;
const STATIC = b2.b2BodyType.b2_staticBody, KINEMATIC = b2.b2BodyType.b2_kinematicBody, DYNAMIC = b2.b2BodyType.b2_dynamicBody;

function arena(W, half, height) {
  const g = addBody(W, STATIC, 0, 0);
  addBox(g, half, 0.5, {});
  const l = addBody(W, STATIC, -half, height / 2); addBox(l, 0.5, height / 2, {});
  const r = addBody(W, STATIC, half, height / 2); addBox(r, 0.5, height / 2, {});
  return g;
}

// ---------------------------------------------------------------- scenes
const scenes = {
  pile(R) {
    const W = makeWorld(0, -10);
    arena(W, 12, 40);
    const dyn = [];
    for (let i = 0; i < 350; i++) {
      const B = addBody(W, DYNAMIC, range(-10, 10), 2 + i * 0.35, range(0, 6.28));
      randomShape(B, 1, { friction: range(0.1, 0.9), restitution: range(0, 0.5), hit: true });
      dyn.push(B);
    }
    for (let s = 0; s < 900; s++) {
      if (s >= 600 && s % 40 === 0) for (let k = 0; k < 6; k++) In.impulse(dyn[pick(dyn.length)], range(-8, 8), range(2, 12));
      if (s === 700) for (let k = 0; k < 20; k++) In.angImpulse(dyn[pick(dyn.length)], range(-3, 3));
      step(W, 1 / 60, 4); record(W, R); R.endStep();
    }
    return [W];
  },
  joints(R) {
    const W = makeWorld(0, -10);
    const ground = arena(W, 40, 20);
    // rope bridge of revolute joints with limits and springs
    let prev = ground;
    const links = [];
    for (let i = 0; i < 30; i++) {
      const B = addBody(W, DYNAMIC, -15 + i, 10); addCapsule(B, 0.45, 0.12, { density: 2 });
      const d = b2.b2DefaultRevoluteJointDef();
      jointBase(d, prev, B, prev === ground ? -15.5 : 0.5, prev === ground ? 10 : 0, -0.5, 0);
      d.enableLimit = i % 3 === 0; d.lowerAngle = -0.6; d.upperAngle = 0.6;
      d.enableSpring = i % 2 === 0; d.hertz = 3; d.dampingRatio = 0.4;
      W.joints.push(b2.b2CreateRevoluteJoint(W.id, d)); d.delete();
      links.push(B); prev = B;
    }
    { const d = b2.b2DefaultRevoluteJointDef(); jointBase(d, prev, ground, 0.5, 0, 15.5, 10); W.joints.push(b2.b2CreateRevoluteJoint(W.id, d)); d.delete(); }
    // distance-joint springs hanging weights from the bridge
    for (let i = 2; i < 30; i += 4) {
      const B = addBody(W, DYNAMIC, -15 + i, 7); addCircle(B, 0.4, { density: 3 });
      const d = b2.b2DefaultDistanceJointDef(); jointBase(d, links[i], B, 0, 0, 0, 0);
      d.length = 3; d.enableSpring = true; d.hertz = 2; d.dampingRatio = 0.2; d.enableLimit = true; d.minLength = 1.5; d.maxLength = 4;
      W.joints.push(b2.b2CreateDistanceJoint(W.id, d)); d.delete();
    }
    // prismatic with motor and limits
    const slider = addBody(W, DYNAMIC, -25, 3); addBox(slider, 0.6, 0.6, {});
    { const d = b2.b2DefaultPrismaticJointDef(); jointBase(d, ground, slider, -25, 3, 0, 0);
      d.enableLimit = true; d.lowerTranslation = -4; d.upperTranslation = 4; d.enableMotor = true; d.motorSpeed = 2; d.maxMotorForce = 200;
      d.enableSpring = true; d.hertz = 1; d.dampingRatio = 0.3;
      W.joints.push(b2.b2CreatePrismaticJoint(W.id, d)); d.delete(); }
    // welded cluster
    const core = addBody(W, DYNAMIC, 25, 8); addBox(core, 0.5, 0.5, {});
    for (let k = 0; k < 5; k++) {
      const B = addBody(W, DYNAMIC, 25 + Math.cos(k) * 1.2, 8 + Math.sin(k) * 1.2); addCircle(B, 0.35, {});
      const d = b2.b2DefaultWeldJointDef(); jointBase(d, core, B, Math.cos(k) * 1.2, Math.sin(k) * 1.2, 0, 0);
      d.linearHertz = k % 2 ? 0 : 4; d.angularHertz = k % 2 ? 0 : 3; d.linearDampingRatio = 0.5; d.angularDampingRatio = 0.5;
      W.joints.push(b2.b2CreateWeldJoint(W.id, d)); d.delete();
    }
    // wheel-joint car driving over bumps
    const chassis = addBody(W, DYNAMIC, -30, 2); addBox(chassis, 1.5, 0.4, { density: 1 });
    for (const dx of [-1, 1]) {
      const wheel = addBody(W, DYNAMIC, -30 + dx, 1.3); addCircle(wheel, 0.5, { friction: 1.2, density: 1.5 });
      const d = b2.b2DefaultWheelJointDef(); jointBase(d, chassis, wheel, dx, -0.7, 0, 0);
      d.enableSpring = true; d.hertz = 4; d.dampingRatio = 0.7; d.enableMotor = true; d.motorSpeed = -6; d.maxMotorTorque = 40;
      d.enableLimit = true; d.lowerTranslation = -0.3; d.upperTranslation = 0.3;
      W.joints.push(b2.b2CreateWheelJoint(W.id, d)); d.delete();
    }
    for (let k = 0; k < 12; k++) { const bump = addBody(W, STATIC, -22 + k * 3, 0.6); addBox(bump, 0.4, 0.15, {}); }
    // motor joint pulling a body to a moving target
    const puppet = addBody(W, DYNAMIC, 0, 15); addBox(puppet, 0.5, 0.5, {});
    { const d = b2.b2DefaultMotorJointDef(); jointBase(d, ground, puppet, 0, 15, 0, 0); d.linearHertz = 2; d.linearDampingRatio = 0.7; d.maxSpringForce = 500; d.angularHertz = 2; d.angularDampingRatio = 0.7; d.maxSpringTorque = 100;
      W.joints.push(b2.b2CreateMotorJoint(W.id, d)); d.delete(); }
    for (let s = 0; s < 700; s++) {
      if (s % 90 === 30) In.impulse(links[pick(30)], range(-10, 10), range(5, 20));
      if (s % 50 === 0) In.torque(core, range(-200, 200));
      In.force(puppet, Math.sin(s * 0.1) * 30, 0);
      if (s === 400) { b2.b2DestroyJoint(W.joints[10], true); b2.b2DestroyJoint(W.joints[20], true); }
      step(W, 1 / 60, 4); record(W, R); R.endStep();
    }
    return [W];
  },
  sensors(R) {
    const W = makeWorld(0, -6);
    arena(W, 15, 30);
    for (let k = 0; k < 6; k++) { const S = addBody(W, STATIC, -10 + k * 4, 6 + (k % 3) * 4); addBox(S, 1.5, 1, { sensor: true }); }
    const mover = addBody(W, KINEMATIC, 0, 3); addCircle(mover, 2, { sensor: true });
    const dyn = [];
    for (let i = 0; i < 120; i++) {
      const B = addBody(W, DYNAMIC, range(-12, 12), 18 + i * 0.3, range(0, 6)); randomShape(B, 0.7, { restitution: 0.6 }); dyn.push(B);
    }
    const carrier = addBody(W, DYNAMIC, 5, 25); addBox(carrier, 0.4, 0.4, {}); addCircle(carrier, 1.5, { sensor: true, density: 0 });
    for (let s = 0; s < 700; s++) {
      In.vel(mover, Math.cos(s * 0.05) * 6, Math.sin(s * 0.07) * 2);
      if (s % 120 === 100) for (let k = 0; k < 15; k++) { const B = dyn[pick(dyn.length)]; In.position(B, range(-12, 12), range(15, 25)); In.vel(B, range(-3, 3), range(-2, 4)); }
      step(W, 1 / 60, 4); record(W, R); R.endStep();
    }
    return [W];
  },
  sleepwake(R) {
    const W = makeWorld(0, -10);
    arena(W, 20, 20);
    const dyn = [];
    for (let i = 0; i < 150; i++) {
      const B = addBody(W, DYNAMIC, -18 + (i % 30) * 1.2, 1.2 + Math.floor(i / 30) * 1.1, 0, { sleepThreshold: i % 5 === 0 ? 0.2 : 0.05, enableSleep: i % 17 !== 0 });
      addBox(B, 0.5, 0.5, { friction: 0.8 }); dyn.push(B);
    }
    const platform = addBody(W, KINEMATIC, 0, 9); addBox(platform, 3, 0.2, {});
    for (let i = 0; i < 8; i++) { const B = addBody(W, DYNAMIC, -2 + i * 0.6, 10); addCircle(B, 0.25, { rolling: 0.05 }); dyn.push(B); }
    for (let s = 0; s < 1400; s++) {
      if (s === 500) for (let k = 0; k < 5; k++) In.impulse(dyn[pick(150)], range(-5, 5), range(3, 9));
      if (s === 620) for (let k = 0; k < 10; k++) In.awake(dyn[pick(150)], true);
      if (s === 640) for (let k = 0; k < 10; k++) In.awake(dyn[pick(150)], false);
      if (s === 900) for (let k = 0; k < 8; k++) In.angle(dyn[pick(150)], range(0, 3));
      if (s === 950) for (let k = 0; k < 8; k++) In.position(dyn[pick(150)], range(-15, 15), range(8, 14));
      if (s >= 1000 && s < 1100) In.vel(platform, Math.sin(s * 0.1) * 3, 0); else if (s === 1100) In.vel(platform, 0, 0);
      if (s === 1150) { In.type(dyn[3], KINEMATIC); In.vel(dyn[3], 1, 0.5); In.type(dyn[40], STATIC); In.gravityScale(dyn[80], -0.5); }
      if (s === 1250) { In.type(dyn[3], DYNAMIC); In.type(dyn[40], DYNAMIC); }
      step(W, 1 / 60, 4); record(W, R); R.endStep();
    }
    return [W];
  },
  churn(R) {
    const W = makeWorld(0, -10);
    const ground = arena(W, 14, 60);
    const spawn = () => { const B = addBody(W, DYNAMIC, range(-12, 12), range(5, 30), range(0, 6), { vx: range(-3, 3), vy: range(-3, 3), w: range(-2, 2), bullet: rnd() < 0.05 }); randomShape(B, 0.8, { hit: rnd() < 0.3, restitution: range(0, 0.4) }); if (rnd() < 0.2) randomShape(B, 0.5, {}); return B; };
    let live = []; for (let i = 0; i < 200; i++) live.push(spawn());
    const tethers = [];
    for (let s = 0; s < 1000; s++) {
      const kill = 1 + pick(4);
      for (let k = 0; k < kill && live.length > 50; k++) {
        const at = pick(live.length); const B = live[at]; live[at] = live[live.length - 1]; live.pop();
        for (let t = tethers.length - 1; t >= 0; t--) if (tethers[t].a === B || tethers[t].b === B) tethers.splice(t, 1); // joint dies with the body
        destroyBody(W, B);
      }
      const born = 1 + pick(4); for (let k = 0; k < born; k++) live.push(spawn());
      if (s % 25 === 0) {
        const a = live[pick(live.length)], b = live[pick(live.length)];
        if (a !== b) { const d = b2.b2DefaultDistanceJointDef(); jointBase(d, a, b, 0, 0, 0, 0); d.length = 2; d.enableSpring = true; d.hertz = 3; d.dampingRatio = 0.3; tethers.push({ a, b, j: b2.b2CreateDistanceJoint(W.id, d) }); d.delete(); }
      }
      if (s % 60 === 59 && tethers.length) { const t = tethers.splice(pick(tethers.length), 1)[0]; b2.b2DestroyJoint(t.j, true); }
      if (s % 10 === 0) In.impulse(live[pick(live.length)], range(-4, 4), range(0, 6));
      step(W, 1 / 60, 4); record(W, R); R.endStep();
      W.bodies = W.bodies.filter((B) => B.alive);
    }
    return [W];
  },
  multiworld(R) {
    const build = (k) => {
      const W = makeWorld(k % 3 === 0 ? 0 : range(-2, 2), k % 3 === 0 ? 0 : -range(4, 12), k % 2 === 0);
      W.dt = k % 2 ? 1 / 30 : 1 / 60; W.sub = 2 + (k % 4); W.dyn = [];
      if (k % 3 !== 0) arena(W, 8, 20);
      const n = 10 + pick(40);
      for (let i = 0; i < n; i++) { const B = addBody(W, DYNAMIC, range(-6, 6), range(2, 15), range(0, 6), { vx: range(-2, 2), vy: range(-2, 2), w: range(-1, 1) }); randomShape(B, 0.8, { restitution: 0.3, hit: true }); W.dyn.push(B); }
      return W;
    };
    let worlds = []; for (let k = 0; k < 12; k++) worlds.push(build(k));
    const all = [...worlds];
    for (let s = 0; s < 600; s++) {
      if (s === 200) { for (const k of [7, 3]) { b2.b2DestroyWorld(worlds[k].id); worlds.splice(k, 1); } }
      if (s === 220 || s === 260) { const W = build(20 + s); worlds.push(W); all.push(W); }
      // interleave: inputs to all, then steps in a rotating order, then a second partial pass
      for (const W of worlds) if (s % 7 === 0) In.impulse(W.dyn[pick(W.dyn.length)], range(-3, 3), range(-3, 3));
      for (let k = 0; k < worlds.length; k++) { const W = worlds[(k + s) % worlds.length]; step(W, W.dt, W.sub); }
      for (const W of worlds) record(W, R);
      if (s % 3 === 0) for (let k = 0; k < worlds.length; k += 2) { const W = worlds[k]; step(W, W.dt, W.sub); record(W, R); }
      R.endStep();
    }
    return worlds;
  },
  bullets(R) {
    const W = makeWorld(0, 0);
    for (let k = 0; k < 10; k++) { const wall = addBody(W, STATIC, 10 + k * 2, 0); addBox(wall, 0.05, 20, {}); }
    const paddle = addBody(W, KINEMATIC, 5, 0); addBox(paddle, 0.1, 4, {}); In.angVel(paddle, 3);
    const shots = [];
    for (let i = 0; i < 60; i++) { const B = addBody(W, DYNAMIC, -5 - i * 0.5, range(-15, 15), 0, { bullet: i % 2 === 0, vx: range(80, 300), vy: range(-20, 20) }); addCircle(B, 0.1, { restitution: 0.8, hit: true }); shots.push(B); }
    for (let s = 0; s < 500; s++) {
      if (s % 100 === 50) for (const B of shots) if (rnd() < 0.3) In.vel(B, range(-250, 250), range(-60, 60));
      step(W, 1 / 60, 4); record(W, R); R.endStep();
    }
    return [W];
  },
};

const out = { pkg: pkgDir, flavour, mode, scenes: {} };
for (const [name, run] of Object.entries(scenes)) {
  seed = 12345;
  stats = { contacts: 0, hits: 0, sensor: 0, minAwake: 1e9, maxAwake: 0 };
  const R = new Recorder();
  const worlds = run(R);
  const c = b2.b2World_GetCounters(worlds[0].id);
  stats.joints = c.jointCount; stats.bodies = c.bodyCount; c.delete?.();
  for (const W of worlds) b2.b2DestroyWorld(W.id);
  out.scenes[name] = { sha: R.sha.digest("hex"), steps: R.steps, values: R.values, stats };
  console.log(`${flavour}/${mode} ${name.padEnd(10)} ${out.scenes[name].sha.slice(0, 16)} steps=${R.steps.length} values=${R.values} ${JSON.stringify(stats)}`);
}
out.mismatches = mismatches;
out.heapBytes = b2.HEAPU8.length;
if (FAST) console.log(`in-process fast-vs-embind mismatches: ${mismatches}`);
writeFileSync(outFile, JSON.stringify(out));
process.exit(mismatches ? 1 : 0);

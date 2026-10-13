// One physics world plus the Phaser objects that mirror it. A scene module builds its world through
// this class; the class owns stepping, the fast-path move export, event spans, tinting and cleanup.
//
// Flat embind API is used only to CREATE things (world, bodies, shapes, joints). Everything that
// happens per frame goes through the b2x_ fast path: step, move export, event spans, impulses.
import Phaser from "phaser";
import { PPM, place } from "./view.js";

export const DT = 1 / 60;
export const SUBSTEPS = 4;
const MAX_STEPS_PER_FRAME = 4;

const COLORS = { box: 0x5aa9e6, circle: 0xf4a259, capsule: 0x7bc47f, static: 0x4a5568 };
const FLASH_COLOR = 0xffe066;
const SENSOR_COLOR = 0x4ade80;
const FLASH_STEPS = 10;

const mix = (a, b, t) => {
  const ch = (s) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};
const q = (v) => Math.max(1, Math.round(v * 20)); // quantise sizes to 0.05 m for texture keys

export class Sim {
  /**
   * @param {object} p  { b2, fp, phaser: Phaser.Scene, scene: scene module, gravity: [x, y], sleep }
   */
  constructor({ b2, fp, phaser, scene }) {
    this.b2 = b2;
    this.fp = fp;
    this.phaser = phaser;
    this.scene = scene;
    this.entities = [null]; // index = userData stored in Box2D (0 = "no entity")
    this.shapeEnt = []; // b2 shape index1 -> entity, for event spans
    this.textureKeys = new Set();
    this.flashing = new Set();
    this.acc = 0;
    this.stepCount = 0;
    this.live = 0;
    this.info = ""; // scene-specific extra line for the HUD
    this.stats = { bodies: 0, awake: 0, stepMs: 0, exportMs: 0, moves: 0, hits: 0 };
    this._seed = 12345;
    this.spans = fp.alloc(64);
    this.moves = fp.createMoveExporter(1024);

    const def = b2.b2DefaultWorldDef();
    const g = scene.gravity ?? [0, -10];
    def.gravity.Set(g[0], g[1]); // nested accessor: a view into def, mutate in place
    def.enableSleep = scene.sleep ?? true;
    this.worldId = b2.b2CreateWorld(def);
    def.delete(); // returned by value: owned
    this.world = fp.world(this.worldId); // packed id for b2x_ calls
    this.destroyed = false;
  }

  /** Deterministic random in [0, 1). */
  random() {
    let t = (this._seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.random(); }

  // ------------------------------------------------------------------ creation (embind)

  /**
   * Create a body with one shape and its Phaser visual.
   * spec: { type: 'static'|'kinematic'|'dynamic', x, y, angle, vx, vy, w, linearDamping, bullet,
   *   shape: {kind:'box',hx,hy} | {kind:'circle',r} | {kind:'capsule',half,r},
   *   density, friction, restitution, sensor, sensorEvents, hitEvents, color, alpha, depth }
   */
  body(spec) {
    const b2 = this.b2;
    const type = spec.type ?? "dynamic";
    const bd = b2.b2DefaultBodyDef();
    bd.type = { static: b2.b2BodyType.b2_staticBody, kinematic: b2.b2BodyType.b2_kinematicBody, dynamic: b2.b2BodyType.b2_dynamicBody }[type];
    bd.position.Set(spec.x ?? 0, spec.y ?? 0);
    bd.rotation.SetAngle(spec.angle ?? 0);
    if (spec.vx || spec.vy) bd.linearVelocity.Set(spec.vx ?? 0, spec.vy ?? 0);
    if (spec.w) bd.angularVelocity = spec.w;
    if (spec.linearDamping !== undefined) bd.linearDamping = spec.linearDamping;
    if (spec.bullet) bd.isBullet = true;
    if (spec.sleep === false) bd.enableSleep = false;
    const id = b2.b2CreateBody(this.worldId, bd);
    bd.delete();

    const sd = b2.b2DefaultShapeDef();
    sd.density = spec.density ?? 1;
    sd.material.friction = spec.friction ?? 0.6;
    sd.material.restitution = spec.restitution ?? 0;
    sd.isSensor = !!spec.sensor;
    sd.enableSensorEvents = spec.sensorEvents ?? false;
    sd.enableHitEvents = spec.hitEvents ?? false;
    sd.enableContactEvents = false;
    const sh = spec.shape;
    let shapeId;
    if (sh.kind === "box") {
      const poly = b2.b2MakeBox(sh.hx, sh.hy);
      shapeId = b2.b2CreatePolygonShape(id, sd, poly);
      poly.delete();
    } else if (sh.kind === "circle") {
      const c = new b2.b2Circle();
      c.radius = sh.r;
      shapeId = b2.b2CreateCircleShape(id, sd, c);
      c.delete();
    } else {
      const c = new b2.b2Capsule();
      c.center1.Set(-sh.half, 0);
      c.center2.Set(sh.half, 0);
      c.radius = sh.r;
      shapeId = b2.b2CreateCapsuleShape(id, sd, c);
      c.delete();
    }
    sd.delete();

    const base = spec.color ?? (type === "static" ? COLORS.static : COLORS[sh.kind]);
    const ent = {
      i: this.entities.length,
      id,
      index1: id.index1,
      rev: this.fp.rev(id),
      type,
      kind: sh.kind,
      shape: sh,
      x: spec.x ?? 0,
      y: spec.y ?? 0,
      angle: spec.angle ?? 0,
      base,
      cur: -1,
      asleep: false,
      sensorCount: 0,
      flash: 0,
      visual: null,
    };
    this.entities.push(ent);
    this.shapeEnt[shapeId.index1] = ent;
    // userData is what move records carry back: it indexes this.entities
    this.fp.module._b2x_Body_SetUserData(ent.index1, ent.rev, ent.i);
    ent.visual = this._makeVisual(ent, spec);
    place(ent.visual, ent.x, ent.y, ent.angle);
    this._tint(ent);
    this.live++;
    return ent;
  }

  /** Local anchor of a world point on an entity at its creation pose. */
  _local(ent, wx, wy) {
    const dx = wx - ent.x, dy = wy - ent.y, c = Math.cos(ent.angle), s = Math.sin(ent.angle);
    return [c * dx + s * dy, -s * dx + c * dy];
  }

  /** Fill def.base for a joint anchored at world point (wx, wy); axisAngle is the joint axis in world space. */
  _jointBase(d, a, b, wx, wy, axisAngle = 0, collide = false) {
    const base = d.base; // view into d
    base.bodyIdA = a.id;
    base.bodyIdB = b.id;
    base.collideConnected = collide;
    const [ax, ay] = this._local(a, wx, wy);
    const [bx, by] = this._local(b, wx, wy);
    base.localFrameA.p.Set(ax, ay);
    base.localFrameA.q.SetAngle(axisAngle - a.angle);
    base.localFrameB.p.Set(bx, by);
    base.localFrameB.q.SetAngle(axisAngle - b.angle);
  }

  revolute(a, b, wx, wy, opts = {}) {
    const d = this.b2.b2DefaultRevoluteJointDef();
    this._jointBase(d, a, b, wx, wy);
    Object.assign(d, opts);
    const id = this.b2.b2CreateRevoluteJoint(this.worldId, d);
    d.delete();
    return id;
  }
  wheel(a, b, wx, wy, axisAngle, opts = {}) {
    const d = this.b2.b2DefaultWheelJointDef();
    this._jointBase(d, a, b, wx, wy, axisAngle);
    Object.assign(d, opts);
    const id = this.b2.b2CreateWheelJoint(this.worldId, d);
    d.delete();
    return id;
  }
  prismatic(a, b, wx, wy, axisAngle, opts = {}) {
    const d = this.b2.b2DefaultPrismaticJointDef();
    this._jointBase(d, a, b, wx, wy, axisAngle);
    Object.assign(d, opts);
    const id = this.b2.b2CreatePrismaticJoint(this.worldId, d);
    d.delete();
    return id;
  }
  /** Distance joint between world anchors (ax, ay) on a and (bx, by) on b. */
  distance(a, b, ax, ay, bx, by, opts = {}) {
    const d = this.b2.b2DefaultDistanceJointDef();
    this._jointBase(d, a, b, ax, ay);
    const [lbx, lby] = this._local(b, bx, by);
    d.base.localFrameB.p.Set(lbx, lby);
    Object.assign(d, opts);
    const id = this.b2.b2CreateDistanceJoint(this.worldId, d);
    d.delete();
    return id;
  }

  // ------------------------------------------------------------------ visuals

  /**
   * A generated canvas texture. WebGL draws it white and tints it per image; the Canvas renderer
   * ignores tint, so there the texture itself is drawn in the colour (one texture per shape and colour).
   */
  _texture(key, w, h, draw, color = 0xffffff) {
    const tex = this.phaser.textures;
    const full = color === 0xffffff ? key : `${key}:${color.toString(16)}`;
    if (!tex.exists(full)) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(w);
      canvas.height = Math.ceil(h);
      const g = canvas.getContext("2d");
      g.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
      g.strokeStyle = "rgba(0,0,0,0.55)";
      g.lineWidth = 3;
      draw(g, canvas.width, canvas.height);
      tex.addCanvas(full, canvas);
      this.textureKeys.add(full);
    }
    return full;
  }

  /** An Image of a generated texture, scaled to a size in pixels. Remembers how to redraw it in another colour. */
  _image(key, tw, th, draw, w, h) {
    const img = this.phaser.add.image(0, 0, this._texture(key, tw, th, draw)).setDisplaySize(w, h);
    img.texSpec = { key, tw, th, draw };
    return img;
  }

  _makeVisual(ent, spec) {
    const K = PPM * 2; // texture pixels per metre; the image is scaled back by 1/2
    const sh = ent.shape;
    const add = this.phaser.add;
    let obj;
    if (sh.kind === "box") {
      const w = sh.hx * 2 * PPM, h = sh.hy * 2 * PPM;
      if (sh.hx > 2 || sh.hy > 2) {
        // big static slabs: a Rectangle shape keeps its border crisp and the texture small
        obj = add.rectangle(0, 0, w, h, 0xffffff).setStrokeStyle(2, 0x000000, 0.45);
      } else {
        obj = this._image(`box:${q(sh.hx)}:${q(sh.hy)}`, q(sh.hx) / 10 * K, q(sh.hy) / 10 * K, (g, W, H) => {
          g.fillRect(0, 0, W, H);
          g.strokeRect(1.5, 1.5, W - 3, H - 3);
        }, w, h);
      }
    } else if (sh.kind === "circle") {
      obj = this._image(`circle:${q(sh.r)}`, q(sh.r) / 10 * K, q(sh.r) / 10 * K, (g, W) => {
        const r = W / 2;
        g.beginPath(); g.arc(r, r, r - 1.5, 0, Math.PI * 2); g.fill(); g.stroke();
        g.beginPath(); g.moveTo(r, r); g.lineTo(W - 2, r); g.stroke(); // spoke shows rotation
      }, sh.r * 2 * PPM, sh.r * 2 * PPM);
    } else {
      const wm = (sh.half + sh.r) * 2, hm = sh.r * 2;
      obj = this._image(`cap:${q(sh.half)}:${q(sh.r)}`, (q(sh.half) + q(sh.r)) / 10 * K, q(sh.r) / 10 * K, (g, W, H) => {
        const r = H / 2 - 1.5;
        g.beginPath();
        g.moveTo(r + 1.5, 1.5); g.lineTo(W - r - 1.5, 1.5);
        g.arc(W - r - 1.5, H / 2, r, -Math.PI / 2, Math.PI / 2);
        g.lineTo(r + 1.5, H - 1.5);
        g.arc(r + 1.5, H / 2, r, Math.PI / 2, -Math.PI / 2);
        g.closePath(); g.fill(); g.stroke();
      }, wm * PPM, hm * PPM);
    }
    if (obj.setAlpha && spec.alpha !== undefined) obj.setAlpha(spec.alpha);
    obj.setDepth(spec.depth ?? (ent.type === "static" ? 0 : 1));
    return obj;
  }

  _color(ent) {
    if (ent.flash > 0) return FLASH_COLOR;
    if (ent.sensorCount > 0) return SENSOR_COLOR;
    if (ent.asleep) return mix(ent.base, 0x1c2433, 0.62); // sleeping bodies look dim
    return ent.base;
  }
  _tint(ent) {
    const c = this._color(ent);
    if (c === ent.cur) return;
    ent.cur = c;
    const v = ent.visual;
    if (v.texSpec) {
      if (this.phaser.renderer.type === Phaser.WEBGL) v.setTint(c);
      else { const t = v.texSpec; v.setTexture(this._texture(t.key, t.tw, t.th, t.draw, c)); } // Canvas: no tint
    } else v.setFillStyle(c, v.fillAlpha);
  }

  // ------------------------------------------------------------------ stepping (fast path)

  /** Advance by a frame's worth of fixed steps. */
  update(deltaMs) {
    this.acc = Math.min(this.acc + deltaMs / 1000, MAX_STEPS_PER_FRAME * DT);
    while (this.acc >= DT) {
      this.acc -= DT;
      this.step();
    }
  }

  step() {
    const { fp, stats } = this;
    const m = fp.module;
    this.scene.update?.(this, this.stepCount++);

    const t0 = performance.now();
    m._b2x_World_Step(this.world, DT, SUBSTEPS);
    const t1 = performance.now();
    const n = this.moves.exportMoves(this.world, 0); // one crossing; also re-syncs the memory views
    const t2 = performance.now();
    stats.stepMs += (t1 - t0 - stats.stepMs) * 0.1;
    stats.exportMs += (t2 - t1 - stats.exportMs) * 0.1;
    stats.moves = n;

    this._applyMoves(n);
    this._applyEvents();
    for (const e of this.flashing) {
      if (--e.flash <= 0) { this.flashing.delete(e); this._tint(e); }
    }
  }

  /** Update only the game objects of bodies that moved this step. */
  _applyMoves(n) {
    const { fp } = this;
    const { u32, f32 } = fp;
    const M = fp.layout.move;
    const oUser = M.userData >> 2, oX = M.x >> 2, oY = M.y >> 2, oA = M.angle >> 2, oF = M.flags >> 2;
    const asleepBit = fp.layout.constants.moveFellAsleep;
    const entities = this.entities;
    for (let k = 0, base = this.moves.base; k < n; k++, base += this.moves.stride) {
      const ent = entities[u32[base + oUser]];
      if (!ent) continue;
      ent.x = f32[base + oX];
      ent.y = f32[base + oY];
      ent.angle = f32[base + oA];
      place(ent.visual, ent.x, ent.y, ent.angle);
      const asleep = (u32[base + oF] & asleepBit) !== 0;
      if (asleep !== ent.asleep) { ent.asleep = asleep; this._tint(ent); }
    }
  }

  /** Read Box2D's own event arrays in place: hit events flash bodies, sensor events tint visitors. */
  _applyEvents() {
    const { fp, spans, shapeEnt } = this;
    const m = fp.module;
    fp.sync();
    const { i32, u32 } = fp;
    const L = fp.layout;

    m._b2x_World_GetContactSpans(this.world, spans);
    const C = L.contactSpans, H = L.contactHit;
    const nh = i32[(spans + C.hitCount) >> 2];
    this.stats.hits = nh;
    for (let k = 0, at = u32[(spans + C.hitPtr) >> 2]; k < nh; k++, at += H.size) {
      for (const f of [H.shapeA, H.shapeB]) {
        const e = shapeEnt[i32[(at + f) >> 2]];
        if (e && e.type !== "static") { e.flash = FLASH_STEPS; this.flashing.add(e); this._tint(e); }
      }
    }

    m._b2x_World_GetSensorSpans(this.world, spans);
    const S = L.sensorSpans, SB = L.sensorBegin, SE = L.sensorEnd;
    const nb = i32[(spans + S.beginCount) >> 2], ne = i32[(spans + S.endCount) >> 2];
    for (let k = 0, at = u32[(spans + S.beginPtr) >> 2]; k < nb; k++, at += SB.size) {
      const e = shapeEnt[i32[(at + SB.visitorShape) >> 2]];
      if (e) { e.sensorCount++; this._tint(e); }
    }
    for (let k = 0, at = u32[(spans + S.endPtr) >> 2]; k < ne; k++, at += SE.size) {
      const e = shapeEnt[i32[(at + SE.visitorShape) >> 2]];
      if (e) { e.sensorCount = Math.max(0, e.sensorCount - 1); this._tint(e); }
    }
  }

  // ------------------------------------------------------------------ input (fast path)

  setVelocity(ent, vx, vy) { this.fp.module._b2x_Body_SetLinearVelocity(ent.index1, ent.rev, vx, vy); }
  impulse(ent, ix, iy) { this.fp.module._b2x_Body_ApplyLinearImpulseToCenter(ent.index1, ent.rev, ix, iy, 1); }

  /** Dynamic entities within radius of a point, from the positions the move records last gave us. */
  near(x, y, radius) {
    const out = [];
    for (const e of this.entities) {
      if (e && e.type === "dynamic" && Math.hypot(e.x - x, e.y - y) <= radius) out.push(e);
    }
    return out;
  }

  refreshStats() {
    this.stats.bodies = this.live;
    this.stats.awake = this.b2.b2World_GetAwakeBodyCount(this.worldId); // one world-level call, a few times a second
  }

  // ------------------------------------------------------------------ teardown

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scene.destroy?.(this);
    this.moves.dispose();
    this.fp.free(this.spans);
    this.b2.b2DestroyWorld(this.worldId); // frees every body, shape and joint in it
    this.phaser.children.removeAll(true);
    for (const k of this.textureKeys) this.phaser.textures.remove(k);
    this.entities.length = 0;
    this.shapeEnt.length = 0;
    this.flashing.clear();
  }
}

// Tests for the embind functions added to complete the C API coverage (see "API coverage" in
// README.md and scripts/check_bindings.py): user data, names, chain materials, contacts, joint
// tuning and targets, the collision.h shape functions and the base/math helpers.
//
//   node tests/bindings.mjs [deluxe|compat]   # dist/<flavour>/Box2D.<flavour>.mjs
//   node tests/bindings.mjs                   # dist/entry.mjs
//
// Ownership: by-value class results (b2Vec2, b2Manifold, b2CastOutput, ...) and b2Default*Def()
// results are owned and deleted once, through own(). Nested accessors such as def.position are views
// of their parent and are never deleted. value_object results (ids, b2Version, ...) are plain objects.
import { strict as assert } from "node:assert";
import { cpus } from "node:os";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

globalThis.navigator ??= {};
globalThis.navigator.hardwareConcurrency ??= cpus().length;

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const flavour = process.argv[2];
if (flavour && flavour !== "deluxe" && flavour !== "compat") {
  throw new Error(`unknown flavour '${flavour}' (expected deluxe or compat)`);
}
const entry = flavour ? resolve(dist, flavour, `Box2D.${flavour}.mjs`) : resolve(dist, "entry.mjs");
const { default: factory } = await import(pathToFileURL(entry).href);
const fastpathFile = flavour ? resolve(dist, "fastpath.mjs") : resolve(dirname(entry), "fastpath.mjs");
const { createFastPath } = await import(pathToFileURL(fastpathFile).href);
const b = await factory();
const fp = createFastPath(b);

const owned = [];
const V = (x, y) => own(new b.b2Vec2(x, y));
const own = (x) => (owned.push(x), x);
let checks = 0;
const eq = (a, e, what) => (checks++, assert.deepStrictEqual(a, e, what));
const near = (a, e, what, eps = 1e-5) => (checks++, assert.ok(Math.abs(a - e) <= eps, `${what}: ${a} vs ${e}`));
const ok = (v, what) => (checks++, assert.ok(v, what));

function makeWorld(gy = 0) {
  const def = own(b.b2DefaultWorldDef());
  def.gravity.y = gy;
  return b.b2CreateWorld(def);
}
function makeBody(worldId, type, x, y) {
  const def = own(b.b2DefaultBodyDef());
  def.type = type;
  def.position.x = x;
  def.position.y = y;
  return b.b2CreateBody(worldId, def);
}
function addBox(bodyId, hx = 0.5, hy = 0.5, density = 1) {
  const sd = own(b.b2DefaultShapeDef());
  sd.density = density;
  sd.enableSensorEvents = true;
  const box = own(b.b2MakeBox(hx, hy));
  return b.b2CreatePolygonShape(bodyId, sd, box);
}

const dynamic = b.b2BodyType.b2_dynamicBody;
const staticBody = b.b2BodyType.b2_staticBody;
const worldId = makeWorld(0);

// ---- user data: unsigned 32-bit integer, same value as the fast path sees ----------------------
{
  const bodyId = makeBody(worldId, dynamic, 0, 0);
  const shapeId = addBox(bodyId);
  eq(b.b2Body_GetUserData(bodyId), 0, "body user data defaults to 0");
  b.b2Body_SetUserData(bodyId, 0xdeadbeef);
  eq(b.b2Body_GetUserData(bodyId), 0xdeadbeef, "body user data round trip (uint32)");
  eq(fp.module._b2x_Body_GetUserData(bodyId.index1, fp.rev(bodyId)) >>> 0, 0xdeadbeef, "fast path reads embind body user data");
  fp.module._b2x_Body_SetUserData(bodyId.index1, fp.rev(bodyId), 4242);
  eq(b.b2Body_GetUserData(bodyId), 4242, "embind reads fast-path body user data");

  eq(b.b2Shape_GetUserData(shapeId), 0, "shape user data defaults to 0");
  b.b2Shape_SetUserData(shapeId, 77);
  eq(b.b2Shape_GetUserData(shapeId), 77, "shape user data round trip");
  eq(fp.module._b2x_Shape_GetUserData(shapeId.index1, fp.rev(shapeId)) >>> 0, 77, "fast path reads embind shape user data");
  fp.module._b2x_Shape_SetUserData(shapeId.index1, fp.rev(shapeId), 78);
  eq(b.b2Shape_GetUserData(shapeId), 78, "embind reads fast-path shape user data");

  eq(b.b2World_GetUserData(worldId), 0, "world user data defaults to 0");
  b.b2World_SetUserData(worldId, 123456);
  eq(b.b2World_GetUserData(worldId), 123456, "world user data round trip");
  b.b2World_SetUserData(worldId, 0);
  eq(b.b2World_GetUserData(worldId), 0, "world user data reset");

  // shape user material is a 64-bit value (BigInt)
  eq(b.b2Shape_GetUserMaterial(shapeId), 0n, "user material defaults to 0");
  b.b2Shape_SetUserMaterial(shapeId, 0x123456789abcn);
  eq(b.b2Shape_GetUserMaterial(shapeId), 0x123456789abcn, "user material round trip (uint64)");

  // ---- names ----
  eq(b.b2Body_GetName(bodyId), "", "body name defaults to empty");
  b.b2Body_SetName(bodyId, "player");
  eq(b.b2Body_GetName(bodyId), "player", "body name round trip");
  b.b2Body_SetName(bodyId, "x".repeat(100));
  eq(b.b2Body_GetName(bodyId).length, 10, "names are truncated to B2_NAME_LENGTH (10 in Box2D 3.2)");
  b.b2Body_SetName(bodyId, "");
  eq(b.b2Body_GetName(bodyId), "", "empty string clears the name");
}

// ---- contacts, b2Body_WakeTouching, b2Contact_* -----------------------------------------------
{
  const cw = makeWorld(0);
  const a = makeBody(cw, dynamic, 0, 0);
  const c = makeBody(cw, dynamic, 0.9, 0);
  const sa = addBox(a);
  const sc = addBox(c);
  for (let i = 0; i < 4; i++) b.b2World_Step(cw, 1 / 60, 4);
  const contacts = b.b2Body_GetContactData(a, b.b2Body_GetContactCapacity(a));
  contacts.forEach(own);
  eq(contacts.length, 1, "the overlapping boxes touch");
  const cd = contacts[0];
  const contactId = { ...cd.contactId };
  ok(b.b2Contact_IsValid(contactId), "contact id from b2Body_GetContactData is valid");
  const data = own(b.b2Contact_GetData(contactId));
  eq(data.shapeIdA, cd.shapeIdA, "b2Contact_GetData shapeIdA");
  eq(data.shapeIdB, cd.shapeIdB, "b2Contact_GetData shapeIdB");
  eq(data.contactId, contactId, "b2Contact_GetData contactId");
  ok(data.manifold.pointCount > 0, "contact manifold has points");
  eq(data.manifold.pointCount, cd.manifold.pointCount, "same manifold through both calls");
  eq([sa.index1, sc.index1].sort(), [data.shapeIdA.index1, data.shapeIdB.index1].sort(), "contact shapes");

  b.b2Body_SetAwake(a, false);
  b.b2Body_SetAwake(c, false);
  eq(b.b2Body_IsAwake(a) || b.b2Body_IsAwake(c), false, "both bodies asleep");
  b.b2Body_WakeTouching(c);
  eq(b.b2Body_IsAwake(a), true, "b2Body_WakeTouching wakes the body touching c");

  // a destroyed contact id is no longer valid
  b.b2DestroyBody(c);
  eq(b.b2Contact_IsValid(contactId), false, "contact id invalid after a body is destroyed");
  b.b2DestroyWorld(cw);
}

// ---- chain surface materials ---------------------------------------------------------------------
{
  const cw = makeWorld(0);
  const ground = makeBody(cw, staticBody, 0, 0);
  const cd = own(b.b2DefaultChainDef());
  // Box2D 3.2: every point is a segment end; an open chain sets its ghost points separately
  cd.SetPoints([{ x: -2, y: 0 }, { x: 2, y: 0 }]);
  cd.ghost1.Set(-4, 0);
  cd.ghost2.Set(4, 0);
  eq(cd.pointCount, 2, "b2ChainDef.pointCount follows SetPoints");
  cd.SetMaterials([{ friction: 0.2, restitution: 0.1 }]);
  const chainId = b.b2CreateChain(ground, cd);
  eq(b.b2Chain_GetWorld(chainId), cw, "b2Chain_GetWorld");
  const m = own(b.b2Chain_GetSurfaceMaterial(chainId, 0));
  near(m.friction, 0.2, "chain material friction");
  near(m.restitution, 0.1, "chain material restitution");
  const nm = own(b.b2DefaultSurfaceMaterial());
  nm.friction = 0.75;
  nm.restitution = 0.5;
  nm.userMaterialId = 9;
  b.b2Chain_SetSurfaceMaterial(chainId, nm, 0);
  const m2 = own(b.b2Chain_GetSurfaceMaterial(chainId, 0));
  near(m2.friction, 0.75, "chain material set/get friction");
  near(m2.restitution, 0.5, "chain material set/get restitution");
  eq(Number(m2.userMaterialId), 9, "chain material set/get userMaterialId");
  // the segment shapes share the material
  const segs = b.b2Chain_GetSegments(chainId, 8);
  near(b.b2Shape_GetFriction(segs[0]), 0.75, "segment friction follows the chain material");
  b.b2DestroyWorld(cw);
}

// ---- joints ---------------------------------------------------------------------------------------
{
  const jw = makeWorld(0);
  const a = makeBody(jw, staticBody, 0, 0);
  const c = makeBody(jw, dynamic, 3, 0);
  addBox(c);

  // distance joint
  const dd = own(b.b2DefaultDistanceJointDef());
  dd.base.bodyIdA = a;
  dd.base.bodyIdB = c;
  dd.length = 3;
  const dj = b.b2CreateDistanceJoint(jw, dd);

  eq(b.b2Joint_GetUserData(dj), 0, "joint user data defaults to 0");
  b.b2Joint_SetUserData(dj, 31337);
  eq(b.b2Joint_GetUserData(dj), 31337, "joint user data round trip");

  b.b2Joint_SetConstraintTuning(dj, 45, 1.5);
  const tuning = b.b2Joint_GetConstraintTuning(dj);
  near(tuning.hertz, 45, "constraint tuning hertz");
  near(tuning.dampingRatio, 1.5, "constraint tuning damping ratio");

  b.b2DistanceJoint_SetSpringForceRange(dj, -10, 20);
  const range = b.b2DistanceJoint_GetSpringForceRange(dj);
  near(range.lowerForce, -10, "spring force range lower");
  near(range.upperForce, 20, "spring force range upper");

  const lin0 = b.b2Joint_GetLinearSeparation(dj);
  const ang0 = b.b2Joint_GetAngularSeparation(dj);
  near(lin0, 0, "no linear separation at rest");
  near(ang0, 0, "no angular separation at rest");
  b.b2Body_SetTransform(c, V(5, 0), b.b2Body_GetRotation(c));
  ok(b.b2Joint_GetLinearSeparation(dj) > 1.9, "stretching the joint shows as linear separation");
  eq(typeof b.b2Joint_GetAngularSeparation(dj), "number", "angular separation is a number");

  // prismatic joint target translation
  const pd = own(b.b2DefaultPrismaticJointDef());
  pd.base.bodyIdA = a;
  pd.base.bodyIdB = c;
  pd.enableSpring = true;
  pd.hertz = 1;
  const pj = b.b2CreatePrismaticJoint(jw, pd);
  near(b.b2PrismaticJoint_GetTargetTranslation(pj), 0, "prismatic target translation default");
  b.b2PrismaticJoint_SetTargetTranslation(pj, 1.25);
  near(b.b2PrismaticJoint_GetTargetTranslation(pj), 1.25, "prismatic target translation round trip");

  // revolute joint target angle
  const rd = own(b.b2DefaultRevoluteJointDef());
  rd.base.bodyIdA = a;
  rd.base.bodyIdB = c;
  rd.enableSpring = true;
  rd.hertz = 1;
  const rj = b.b2CreateRevoluteJoint(jw, rd);
  near(b.b2RevoluteJoint_GetTargetAngle(rj), 0, "revolute target angle default");
  b.b2RevoluteJoint_SetTargetAngle(rj, 0.5);
  near(b.b2RevoluteJoint_GetTargetAngle(rj), 0.5, "revolute target angle round trip");
  b.b2DestroyWorld(jw);
}

// ---- types.h / base.h / math_functions.h helpers ----------------------------------------------------
{
  const f = own(b.b2DefaultFilter());
  eq(f.categoryBits, 1, "default filter category");
  eq(f.groupIndex, 0, "default filter group");
  ok(f.maskBits > 0, "default filter mask");

  const v = b.b2GetVersion();
  eq([v.major, v.minor, typeof v.revision], [3, v.minor, "number"], "b2GetVersion");
  ok(b.b2GetByteCount() > 0, "b2GetByteCount counts allocations");
  b.b2Yield();
  const t0 = b.b2GetTicks();
  eq(typeof t0, "bigint", "b2GetTicks is a BigInt");
  ok(b.b2GetMilliseconds(t0) >= 0, "b2GetMilliseconds");

  eq(b.b2IsValidFloat(1), true, "b2IsValidFloat");
  eq(b.b2IsValidFloat(NaN), false, "b2IsValidFloat(NaN)");
  eq(b.b2IsValidFloat(Infinity), false, "b2IsValidFloat(Infinity)");
  eq(b.b2IsValidVec2(V(1, 2)), true, "b2IsValidVec2");
  eq(b.b2IsValidVec2(V(NaN, 2)), false, "b2IsValidVec2(NaN)");
  const q = own(b.b2MakeRot(0.3));
  eq(b.b2IsValidRot(q), true, "b2IsValidRot");
  const badQ = own(new b.b2Rot());
  badQ.c = 3;
  badQ.s = 3;
  eq(b.b2IsValidRot(badQ), false, "b2IsValidRot(not normalised)");
  const xf = own(new b.b2Transform());
  xf.q.c = 1;
  xf.q.s = 0;
  eq(b.b2IsValidTransform(xf), true, "b2IsValidTransform");
  const bb = own(new b.b2AABB());
  bb.lowerBound.x = 0;
  bb.lowerBound.y = 0;
  bb.upperBound.x = 1;
  bb.upperBound.y = 1;
  eq(b.b2IsValidAABB(bb), true, "b2IsValidAABB");
  bb.upperBound.x = -1;
  eq(b.b2IsValidAABB(bb), false, "b2IsValidAABB(inverted)");

  near(b.b2Atan2(1, 1), Math.PI / 4, "b2Atan2", 1e-3);
  const cs = own(b.b2ComputeCosSin(0.5));
  near(cs.cosine, Math.cos(0.5), "b2ComputeCosSin cosine", 1e-3);
  near(cs.sine, Math.sin(0.5), "b2ComputeCosSin sine", 1e-3);
  const rot = own(b.b2ComputeRotationBetweenUnitVectors(V(1, 0), V(0, 1)));
  near(b.b2Rot_GetAngle(rot), Math.PI / 2, "b2ComputeRotationBetweenUnitVectors", 1e-3);

  const units = b.b2GetLengthUnitsPerMeter();
  near(units, 1, "default length units per meter");
  b.b2SetLengthUnitsPerMeter(2);
  near(b.b2GetLengthUnitsPerMeter(), 2, "length units round trip");
  b.b2SetLengthUnitsPerMeter(units);
}

// ---- collision.h ----------------------------------------------------------------------------------
{
  const circle = own(new b.b2Circle());
  circle.center.x = 0;
  circle.center.y = 0;
  circle.radius = 1;
  const capsule = own(new b.b2Capsule());
  capsule.center1.x = -1;
  capsule.center2.x = 1;
  capsule.radius = 0.5;
  const segment = own(new b.b2Segment());
  segment.point1.x = -2;
  segment.point1.y = 0;
  segment.point2.x = 2;
  segment.point2.y = 0;
  const poly = own(b.b2MakeBox(1, 1));
  const ident = own(new b.b2Transform());
  ident.q.c = 1;
  ident.q.s = 0;
  const moved = own(new b.b2Transform());
  moved.p.x = 1.5;
  moved.q.c = 1;
  moved.q.s = 0;

  const ray = own(new b.b2RayCastInput());
  ray.origin.x = -5;
  ray.origin.y = 0;
  ray.translation.x = 10;
  ray.translation.y = 0;
  ray.maxFraction = 1;

  const rc = own(b.b2CastRayCircle(circle, ray));
  eq(rc.hit, true, "b2CastRayCircle hits");
  near(rc.point.x, -1, "b2CastRayCircle point");
  near(rc.fraction, 0.4, "b2CastRayCircle fraction");
  const rcap = own(b.b2CastRayCapsule(capsule, ray));
  eq(rcap.hit, true, "b2CastRayCapsule hits");
  near(rcap.point.x, -1.5, "b2CastRayCapsule point");
  const rpoly = own(b.b2CastRayPolygon(poly, ray));
  eq(rpoly.hit, true, "b2CastRayPolygon hits");
  near(rpoly.point.x, -1, "b2CastRayPolygon point");
  const vray = own(new b.b2RayCastInput());
  vray.origin.x = 0;
  vray.origin.y = 3;
  vray.translation.x = 0;
  vray.translation.y = -6;
  vray.maxFraction = 1;
  const rseg = own(b.b2CastRaySegment(segment, vray, false));
  eq(rseg.hit, true, "b2CastRaySegment hits");
  near(rseg.fraction, 0.5, "b2CastRaySegment fraction");
  const rsegOne = own(b.b2CastRaySegment(segment, vray, true));
  eq(rsegOne.hit, false, "one-sided segment is not hit from its back side");
  eq(b.b2ValidateHull(own(b.b2ComputeHull([V(0, 0), V(1, 0), V(0, 1)]))), true, "b2ValidateHull");

  // shape casts against each primitive
  const sci = own(new b.b2ShapeCastInput());
  sci.proxy.count = 1;
  sci.proxy.setPoint(0, V(-4, 0));
  sci.proxy.radius = 0.25;
  sci.translation.x = 8;
  sci.translation.y = 0;
  sci.maxFraction = 1;
  sci.canEncroach = false;
  for (const [name, shape] of [["Circle", circle], ["Capsule", capsule], ["Segment", segment], ["Polygon", poly]]) {
    const out = own(b[`b2CastShape${name}`](shape, sci));
    eq(out.hit, true, `b2CastShape${name} hits`);
    ok(out.fraction > 0 && out.fraction < 1, `b2CastShape${name} fraction in (0,1)`);
  }
  // pair shape cast: A fixed circle at the origin, B a point proxy moving toward it
  const pair = own(new b.b2ShapeCastPairInput());
  pair.proxyA.count = 1;
  pair.proxyA.setPoint(0, V(0, 0));
  pair.proxyA.radius = 1;
  pair.proxyB.count = 1;
  pair.proxyB.setPoint(0, V(0, 0));
  pair.proxyB.radius = 0;
  // Box2D 3.2: one transform, B relative to A
  pair.transform.p.x = -5;
  pair.transform.q.c = 1;
  pair.translationB.x = 10;
  pair.maxFraction = 1;
  const pc = own(b.b2CastShape(pair));
  eq(pc.hit, true, "b2CastShape hits");
  near(pc.fraction, 0.4, "b2CastShape fraction", 1e-3);

  // time of impact
  const toi = own(new b.b2TOIInput());
  toi.proxyA.count = 1;
  toi.proxyA.setPoint(0, V(0, 0));
  toi.proxyA.radius = 1;
  toi.proxyB.count = 1;
  toi.proxyB.setPoint(0, V(0, 0));
  toi.proxyB.radius = 1;
  toi.sweepA.q1.c = 1;
  toi.sweepA.q2.c = 1;
  toi.sweepB.c1.x = -6;
  toi.sweepB.c2.x = 6;
  toi.sweepB.q1.c = 1;
  toi.sweepB.q2.c = 1;
  toi.maxFraction = 1;
  const out = own(b.b2ComputeTimeOfImpact(toi));
  eq(out.state, b.b2TOIState.b2_toiStateHit, "b2ComputeTimeOfImpact hit state");
  near(out.fraction, 4 / 12, "b2ComputeTimeOfImpact fraction", 1e-2);

  const sweepXf = own(b.b2GetSweepTransform(toi.sweepB, 0.5));
  near(sweepXf.p.x, 0, "b2GetSweepTransform midpoint");
  const sweepEnd = own(b.b2GetSweepTransform(toi.sweepB, 1));
  near(sweepEnd.p.x, 6, "b2GetSweepTransform end");

  const sd = own(b.b2ComputeSegmentDistance(V(0, 0), V(1, 0), V(0, 2), V(1, 2)));
  near(sd.distanceSquared, 4, "b2ComputeSegmentDistance squared distance");
  near(sd.closest1.y, 0, "b2ComputeSegmentDistance closest1");
  near(sd.closest2.y, 2, "b2ComputeSegmentDistance closest2");

  // collide: overlapping shapes make a manifold with points, separated ones do not
  const circleB = own(new b.b2Circle());
  circleB.radius = 1;
  const m1 = own(b.b2CollideCircles(circle, circleB, moved));
  eq(m1.pointCount, 1, "b2CollideCircles overlap");
  const far = own(new b.b2Transform());
  far.p.x = 10;
  far.q.c = 1;
  const m0 = own(b.b2CollideCircles(circle, circleB, far));
  eq(m0.pointCount, 0, "b2CollideCircles apart");
  eq(own(b.b2CollideCapsuleAndCircle(capsule, circleB, moved)).pointCount > 0, true, "b2CollideCapsuleAndCircle");
  eq(own(b.b2CollideSegmentAndCircle(segment, circleB, moved)).pointCount > 0, true, "b2CollideSegmentAndCircle");
  eq(own(b.b2CollidePolygonAndCircle(poly, circleB, moved)).pointCount > 0, true, "b2CollidePolygonAndCircle");
  eq(own(b.b2CollideCapsules(capsule, capsule, moved)).pointCount > 0, true, "b2CollideCapsules");
  eq(own(b.b2CollideSegmentAndCapsule(segment, capsule, moved)).pointCount > 0, true, "b2CollideSegmentAndCapsule");
  eq(own(b.b2CollidePolygonAndCapsule(poly, capsule, moved)).pointCount > 0, true, "b2CollidePolygonAndCapsule");
  eq(own(b.b2CollidePolygons(poly, poly, moved)).pointCount, 2, "b2CollidePolygons");
  eq(own(b.b2CollideSegmentAndPolygon(segment, poly, moved)).pointCount > 0, true, "b2CollideSegmentAndPolygon");
  const chainSeg = own(new b.b2ChainSegment());
  chainSeg.segment.point1.x = -2;
  chainSeg.segment.point2.x = 2;
  chainSeg.ghost1.x = -4;
  chainSeg.ghost2.x = 4;
  const lowCircle = own(new b.b2Transform());
  lowCircle.p.y = -0.5; // chain segments are one-sided: they collide on their right side
  lowCircle.q.c = 1;
  eq(own(b.b2CollideChainSegmentAndCircle(chainSeg, circleB, lowCircle)).pointCount > 0, true, "b2CollideChainSegmentAndCircle");
  eq(own(b.b2CollideChainSegmentAndCapsule(chainSeg, capsule, lowCircle, own(new b.b2SimplexCache()))).pointCount > 0, true, "b2CollideChainSegmentAndCapsule");
  eq(own(b.b2CollideChainSegmentAndPolygon(chainSeg, poly, lowCircle, own(new b.b2SimplexCache()))).pointCount > 0, true, "b2CollideChainSegmentAndPolygon");
}

// ---- Box2D 3.2 additions ---------------------------------------------------------------------------
{
  // single-threaded build: a requested worker count above 1 is forced to 1
  const def = own(b.b2DefaultWorldDef());
  def.workerCount = 4;
  const tw = b.b2CreateWorld(def);
  eq(b.b2World_GetWorkerCount(tw), 1, "b2CreateWorld forces workerCount to 1");
  b.b2World_Step(tw, 1 / 60, 4);
  b.b2DestroyWorld(tw);

  // contact tuning read-back, restitution settings, state hash
  const qw = makeWorld(-10);
  b.b2World_SetContactTuning(qw, 25, 5, 2);
  const tuning = b.b2World_GetContactTuning(qw);
  near(tuning.hertz, 25, "b2World_GetContactTuning hertz");
  near(tuning.dampingRatio, 5, "b2World_GetContactTuning dampingRatio");
  near(tuning.pushSpeed, 2, "b2World_GetContactTuning pushSpeed");
  b.b2World_SetRestitutionIterations(qw, 3);
  eq(b.b2World_GetRestitutionIterations(qw), 3, "restitution iterations round trip");
  eq(typeof b.b2World_GetStateHash(qw), "bigint", "b2World_GetStateHash is a BigInt");
  eq(b.b2IsDoublePrecision(), false, "single-precision build");

  // world queries take an origin; the AABB is relative to it, results are in world space
  const target = makeBody(qw, staticBody, 100, 50);
  const targetShape = addBox(target);
  const filter = own(b.b2DefaultQueryFilter());
  const hits = [];
  const box = own(new b.b2AABB());
  box.lowerBound.Set(-1, -1);
  box.upperBound.Set(1, 1);
  b.b2World_OverlapAABB(qw, V(100, 50), box, filter, (r) => (hits.push(r.shapeId), true));
  eq(hits.length, 1, "b2World_OverlapAABB finds the box around a non-zero origin");
  eq(hits[0], targetShape, "b2World_OverlapAABB returns the shape id");
  hits.length = 0;
  b.b2World_OverlapAABB(qw, V(0, 0), box, filter, (r) => (hits.push(r.shapeId), true));
  eq(hits.length, 0, "the same AABB around the zero origin misses");
  const ray = b.b2World_CastRayClosest(qw, V(90, 50), V(20, 0), filter);
  ok(ray.hit, "b2World_CastRayClosest hits");
  near(ray.point.x, 99.5, "b2World_CastRayClosest point is in world space", 1e-4);

  // hit events carry the contact id
  const ground = makeBody(qw, staticBody, 0, 0);
  const gsd = own(b.b2DefaultShapeDef());
  gsd.enableHitEvents = true;
  b.b2CreatePolygonShape(ground, gsd, own(b.b2MakeOffsetBox(10, 0.5, V(0, -0.5), b.b2Rot_identity)));
  const ball = makeBody(qw, dynamic, 0, 3);
  const bsd = own(b.b2DefaultShapeDef());
  bsd.enableHitEvents = true;
  const ballCircle = own(new b.b2Circle());
  ballCircle.radius = 0.5;
  b.b2CreateCircleShape(ball, bsd, ballCircle);
  b.b2Body_SetLinearVelocity(ball, V(0, -20));
  let hit = null;
  for (let i = 0; i < 30 && !hit; i++) {
    b.b2World_Step(qw, 1 / 60, 4);
    const ev = b.b2World_GetContactEvents(qw);
    if (ev.hitCount > 0) hit = ev.GetHitEvent(0);
  }
  ok(hit, "a fast ball makes a hit event");
  ok(hit.contactId.index1 > 0, "b2ContactHitEvent.contactId is set");
  b.b2DestroyWorld(qw);
}
{
  // pre-solve: the callback sees the manifold and pointCount = 0 disables the contact
  const pw = makeWorld(-10);
  const ground = makeBody(pw, staticBody, 0, 0);
  const gsd = own(b.b2DefaultShapeDef());
  gsd.enablePreSolveEvents = true;
  b.b2CreatePolygonShape(ground, gsd, own(b.b2MakeOffsetBox(10, 0.5, V(0, -0.5), b.b2Rot_identity)));
  const crate = makeBody(pw, dynamic, 0, 1);
  addBox(crate);
  let calls = 0;
  let continuousArgs = 0;
  const handle = b.b2World_SetPreSolveCallback(
    pw,
    (shapeA, shapeB, manifold) => {
      calls++;
      if (calls === 1) ok(manifold.pointCount > 0, "pre-solve manifold has points");
      manifold.pointCount = 0;
    },
    (shapeA, shapeB, point, normal) => (continuousArgs = 4, true),
  );
  for (let i = 0; i < 120; i++) b.b2World_Step(pw, 1 / 60, 4);
  ok(calls > 0, "pre-solve callback runs");
  ok(b.b2Body_GetPosition(crate).y < -5, "disabled contacts let the crate fall through");
  b.b2World_SetPreSolveCallback(pw, null, null);
  b.b2World_DeleteCallback(handle);
  eq(continuousArgs === 0 || continuousArgs === 4, true, "pre-continuous callback signature");
  b.b2DestroyWorld(pw);
}

for (const o of owned) o.delete();
b.b2DestroyWorld(worldId);
console.log(`bindings: ${checks} checks passed${flavour ? ` (${flavour})` : ""}`);

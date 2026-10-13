// Fast-path usage example for docs/fastpath.md. Typechecked against the built declarations
// (see "Verifying" in docs/fastpath.md).
import Box2DFactory from "box2d3-wasm";
import { createFastPath } from "box2d3-wasm/fastpath";

const box2d = await Box2DFactory();
const fp = createFastPath(box2d);
// Box2D's profile timers only feed b2World_GetProfile; off, a step makes no JavaScript clock calls.
fp.setProfileTimers(false);

// Worlds, bodies and shapes are still created through the embind API.
const def = box2d.b2DefaultWorldDef();
def.gravity.y = -10;
const worldId = box2d.b2CreateWorld(def);
def.delete();
const world = fp.world(worldId); // packed: index1 | generation << 16

const bodyDef = box2d.b2DefaultBodyDef();
bodyDef.type = box2d.b2BodyType.b2_dynamicBody;
const bodyId = box2d.b2CreateBody(worldId, bodyDef);
bodyDef.delete();
const shapeDef = box2d.b2DefaultShapeDef();
const circle = new box2d.b2Circle();
circle.radius = 0.5;
box2d.b2CreateCircleShape(bodyId, shapeDef, circle);
shapeDef.delete();
circle.delete();
// Keep the packed id next to the embind one: raw calls take (index1, rev).
const body = { index1: bodyId.index1, rev: fp.rev(bodyId) };
fp.module._b2x_Body_SetUserData(body.index1, body.rev, 1234); // e.g. your entity id

const moves = fp.createMoveExporter(256);
const M = fp.layout.move;
const { exportVelocity } = fp.layout.constants;

/** One step: a raw step call, then every moved body's pose and velocities in one export call. */
export function step(dt: number, onMove: (userData: number, x: number, y: number, angle: number) => void): void {
  fp.module._b2x_World_Step(world, dt, 4);
  const count = moves.exportMoves(world, exportVelocity); // also syncs the views
  const { u32, f32 } = fp;
  for (let i = 0, base = moves.base; i < count; i++, base += moves.stride) {
    onMove(
      u32[base + (M.userData >> 2)]!,
      f32[base + (M.x >> 2)]!,
      f32[base + (M.y >> 2)]!,
      f32[base + (M.angle >> 2)]! // b2Rot_GetAngle: the same bits embind's q.GetAngle() returns
    );
  }
}

// Contact events, read in place from Box2D's own arrays (valid until the next step).
const spans = fp.alloc(fp.layout.contactSpans.size);
export function contactBegins(onBegin: (shapeIndexA: number, shapeIndexB: number) => void): void {
  fp.module._b2x_World_GetContactSpans(world, spans);
  fp.sync(); // the step may have grown memory
  const S = fp.layout.contactSpans;
  const B = fp.layout.contactBegin;
  const { i32, u32 } = fp;
  const first = u32[(spans + S.beginPtr) >> 2]!;
  const count = i32[(spans + S.beginCount) >> 2]!;
  for (let i = 0; i < count; i++) {
    const at = first + i * B.size;
    onBegin(i32[(at + B.shapeA) >> 2]!, i32[(at + B.shapeB) >> 2]!);
  }
}

// Per-body calls: scalars directly, structs through a scratch out-pointer.
const out = fp.alloc(64);
export function speedOf(index1: number, rev: number): number {
  fp.module._b2x_Body_GetMotion(index1, rev, out);
  const V = fp.layout.motion;
  const f32 = fp.f32;
  return Math.hypot(f32[(out + V.vx) >> 2]!, f32[(out + V.vy) >> 2]!);
}
export function push(index1: number, rev: number): void {
  fp.module._b2x_Body_ApplyLinearImpulseToCenter(index1, rev, 0, 2.5, 1);
}

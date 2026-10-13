// Helpers shared by the scene modules. All of them only build bodies through ctx.body().

/** Static floor + two walls; the floor's top surface is at y = 0. */
export function bin(ctx, half, height, wall = 0.5) {
  ctx.body({ type: "static", x: 0, y: -0.5, shape: { kind: "box", hx: half + wall * 2, hy: 0.5 } });
  ctx.body({ type: "static", x: -half - wall, y: height / 2, shape: { kind: "box", hx: wall, hy: height / 2 } });
  ctx.body({ type: "static", x: half + wall, y: height / 2, shape: { kind: "box", hx: wall, hy: height / 2 } });
}

const BOX = [[0.35, 0.35], [0.5, 0.3], [0.3, 0.5], [0.45, 0.45]];
const CIRCLE = [0.3, 0.4, 0.5];
const CAPSULE = [[0.35, 0.2], [0.5, 0.25]];

/** A random box, circle or capsule from a small fixed set of sizes (keeps the texture cache tiny). */
export function randomBody(ctx, x, y, extra = {}) {
  const k = Math.floor(ctx.random() * 3);
  const pick = (a) => a[Math.floor(ctx.random() * a.length)];
  let shape;
  if (k === 0) { const [hx, hy] = pick(BOX); shape = { kind: "box", hx, hy }; }
  else if (k === 1) shape = { kind: "circle", r: pick(CIRCLE) };
  else { const [half, r] = pick(CAPSULE); shape = { kind: "capsule", half, r }; }
  return ctx.body({ x, y, angle: ctx.range(0, 6.28), shape, friction: ctx.range(0.2, 0.8), restitution: ctx.range(0, 0.3), ...extra });
}

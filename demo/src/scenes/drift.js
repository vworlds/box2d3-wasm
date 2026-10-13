// The workload the fast path was built for: thousands of bodies that never sleep, so nearly every body
// is in the move-event list on every step.
export default {
  name: "drift",
  title: "Drift (3500 bodies)",
  description: "Zero gravity, perfectly elastic bouncing; almost every body moves every step. Watch moves per step and step ms. Click to blast bodies away from the pointer.",
  gravity: [0, 0],
  sleep: false,
  view: { cx: 0, cy: 0, w: 84, h: 48 },
  create(ctx) {
    const W = 40, H = 22.5;
    ctx.body({ type: "static", x: 0, y: -H - 0.5, shape: { kind: "box", hx: W + 1, hy: 0.5 } });
    ctx.body({ type: "static", x: 0, y: H + 0.5, shape: { kind: "box", hx: W + 1, hy: 0.5 } });
    ctx.body({ type: "static", x: -W - 0.5, y: 0, shape: { kind: "box", hx: 0.5, hy: H + 1 } });
    ctx.body({ type: "static", x: W + 0.5, y: 0, shape: { kind: "box", hx: 0.5, hy: H + 1 } });
    const step = 0.95;
    const cols = Math.floor((2 * W - 1) / step), rows = Math.floor((2 * H - 1) / step);
    const palette = [0x5aa9e6, 0xf4a259, 0x7bc47f, 0xe5484d, 0xb794f4];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = ctx.range(0, Math.PI * 2), sp = ctx.range(3, 9);
        const shape = (r + c) % 3 === 0 ? { kind: "box", hx: 0.25, hy: 0.25 } : { kind: "circle", r: 0.3 };
        ctx.body({
          x: -W + 0.5 + c * step, y: -H + 0.5 + r * step, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          shape, friction: 0, restitution: 1, linearDamping: 0, color: palette[(r * 7 + c) % palette.length],
        });
      }
    }
  },
  onClick(ctx, x, y) {
    for (const e of ctx.near(x, y, 8)) {
      const dx = e.x - x, dy = e.y - y, d = Math.hypot(dx, dy) || 1;
      ctx.impulse(e, (dx / d) * 1.5, (dy / d) * 1.5);
    }
  },
};

import { bin, randomBody } from "./common.js";

const ZONES = [[-8, 9, 5, 1.5], [7, 15, 5, 1.5], [-6, 21, 4, 1.2]];

export default {
  name: "sensors",
  title: "Sensors and hits",
  description: "Bodies inside a sensor region turn green (sensor begin/end spans). Hard impacts flash yellow (contact hit spans). Click to drop more.",
  gravity: [0, -10],
  view: { cx: 0, cy: 19, w: 30, h: 44 },
  create(ctx) {
    bin(ctx, 14, 40);
    this.spawned = 0;
    this.zones = ZONES.map(([x, y, hx, hy]) =>
      ctx.body({ type: "static", x, y, sensor: true, sensorEvents: true, color: 0x3b82f6, alpha: 0.28, depth: -1, shape: { kind: "box", hx, hy } }),
    );
    // a kinematic sensor circle sweeping sideways near the floor
    this.sweeper = ctx.body({ type: "kinematic", x: 0, y: 3, sensor: true, sensorEvents: true, color: 0xa855f7, alpha: 0.3, depth: -1, shape: { kind: "circle", r: 2.5 } });
    // angled ledges so things bounce around
    ctx.body({ type: "static", x: 8, y: 5, angle: 0.4, shape: { kind: "box", hx: 4, hy: 0.3 } });
    ctx.body({ type: "static", x: -9, y: 13, angle: -0.35, shape: { kind: "box", hx: 3.5, hy: 0.3 } });
  },
  update(ctx, step) {
    ctx.setVelocity(this.sweeper, Math.cos(step * 0.02) * 7, 0);
    if (this.spawned < 240 && step % 8 === 0) {
      this.spawned++;
      randomBody(ctx, ctx.range(-11, 11), 36, { sensorEvents: true, hitEvents: true, restitution: 0.5 });
    }
    let inside = 0;
    for (const e of ctx.entities) if (e && e.sensorCount > 0) inside++;
    ctx.info = `inside a sensor: ${inside}`;
  },
  onClick(ctx, x, y) {
    for (let i = 0; i < 5; i++) randomBody(ctx, x + ctx.range(-1, 1), y + i, { sensorEvents: true, hitEvents: true, restitution: 0.5 });
  },
};

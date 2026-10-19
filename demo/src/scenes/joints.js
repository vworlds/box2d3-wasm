import { bin } from "./common.js";

const HALF_PI = Math.PI / 2;

export default {
  name: "joints",
  title: "Joints",
  description: "Revolute-joint rope bridge, a wheel-joint car with a motor and spring suspension driving over bumps, a prismatic spring and a distance spring. Click to drop a ball.",
  gravity: [0, -10],
  view: { cx: 0, cy: 11, w: 66, h: 26 },
  create(ctx) {
    bin(ctx, 32, 30);
    this.car = null;
    this.dir = 1;

    // bumps
    for (let x = -24; x <= -10; x += 3.5) {
      ctx.body({ type: "static", x, y: 0.1, shape: { kind: "box", hx: 0.5, hy: 0.15 } });
    }

    // rope bridge: posts + 20 capsule planks chained with revolute joints
    const postY = 4.5, anchorY = 8.5;
    const left = ctx.body({ type: "static", x: -3.5, y: postY, shape: { kind: "box", hx: 0.5, hy: 4 } });
    const right = ctx.body({ type: "static", x: 18.5, y: postY, shape: { kind: "box", hx: 0.5, hy: 4 } });
    const n = 20, span = 21, len = span / n, x0 = -3; // x0: left end of the bridge
    let prev = left;
    for (let i = 0; i < n; i++) {
      const cx = x0 + (i + 0.5) * len;
      const plank = ctx.body({ x: cx, y: anchorY, density: 2, hitEvents: false, shape: { kind: "capsule", half: len / 2 - 0.1, r: 0.12 }, color: 0xc9a66b });
      ctx.revolute(prev, plank, x0 + i * len, anchorY, { enableSpring: true, hertz: 4, dampingRatio: 0.5 });
      prev = plank;
    }
    ctx.revolute(prev, right, x0 + span, anchorY, {});
    for (let i = 0; i < 6; i++) {
      ctx.body({ x: 1 + i * 2.4, y: 12 + (i % 2) * 2, restitution: 0.2, shape: i % 2 ? { kind: "circle", r: 0.5 } : { kind: "box", hx: 0.5, hy: 0.5 } });
    }

    // wheel-joint car
    const chassis = ctx.body({ x: -28, y: 1.8, shape: { kind: "box", hx: 1.6, hy: 0.4 }, color: 0xe5484d, density: 3, sleep: false });
    this.wheelJoints = [];
    for (const dx of [-1.1, 1.1]) {
      const wheel = ctx.body({ x: -28 + dx, y: 1.0, shape: { kind: "circle", r: 0.5 }, friction: 1.2, density: 1.5, color: 0x2f3b4f, sleep: false });
      this.wheelJoints.push(
        ctx.wheel(chassis, wheel, -28 + dx, 1.0, HALF_PI, {
          enableSpring: true, hertz: 4, dampingRatio: 0.7,
          enableLimit: true, lowerTranslation: -0.3, upperTranslation: 0.3,
          enableMotor: true, motorSpeed: -10, maxMotorTorque: 20,
        }),
      );
    }
    this.car = chassis;

    // prismatic spring: a box on a vertical rail anchored to a static block
    const rail = ctx.body({ type: "static", x: 22, y: 16, shape: { kind: "box", hx: 0.8, hy: 0.4 } });
    const slider = ctx.body({ x: 22, y: 12, shape: { kind: "box", hx: 0.8, hy: 0.6 }, color: 0xb794f4 });
    ctx.prismatic(rail, slider, 22, 16, HALF_PI, { enableLimit: true, lowerTranslation: -6, upperTranslation: 1, enableSpring: true, hertz: 1.2, dampingRatio: 0.15 });

    // distance spring: a ball bobbing on a spring
    const hook = ctx.body({ type: "static", x: 27, y: 18, shape: { kind: "box", hx: 0.6, hy: 0.4 } });
    const bob = ctx.body({ x: 27, y: 11, shape: { kind: "circle", r: 0.7 }, color: 0xf4a259 });
    ctx.distance(hook, bob, 27, 18, 27, 11, { length: 4, enableSpring: true, hertz: 1.5, dampingRatio: 0.05, enableLimit: true, minLength: 1, maxLength: 8 });
  },
  update(ctx) {
    // turn the car around at either end (rare, so a plain embind call is fine)
    const x = this.car.x;
    if ((x > -9 && this.dir === 1) || (x < -28 && this.dir === -1)) {
      this.dir = -this.dir;
      for (const j of this.wheelJoints) ctx.b2.b2WheelJoint_SetTargetMotorSpeed(j, -10 * this.dir);
    }
  },
  onClick(ctx, x, y) {
    ctx.body({ x, y, restitution: 0.3, density: 3, shape: { kind: "circle", r: 0.6 } });
  },
};

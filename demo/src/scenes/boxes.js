// A static rendering test: boxes at known angles next to circles and a capsule. Nothing moves
// (gravity 0, static bodies), so a screenshot shows exactly what the visuals look like.
// Reachable at #boxes; it is not in the picker.
const ANGLES = [0, 30, 45, 90];
const SIZES = [[1, 1], [0.7, 0.4], [0.4, 0.9]];

export default {
  name: "boxes",
  title: "Boxes (test)",
  hidden: true,
  description: "Rendering test: boxes at 0, 30, 45 and 90 degrees in three sizes, with circles and a capsule.",
  gravity: [0, 0],
  view: { cx: 0, cy: 0, w: 22, h: 14 },
  create(ctx) {
    SIZES.forEach(([hx, hy], row) => {
      ANGLES.forEach((deg, col) => {
        ctx.body({ type: "static", x: -7.5 + col * 3.5, y: 4 - row * 3.2, angle: (deg * Math.PI) / 180, shape: { kind: "box", hx, hy }, color: 0x5aa9e6 });
      });
      ctx.body({ type: "static", x: 7.5, y: 4 - row * 3.2, shape: { kind: "circle", r: 0.8 } });
    });
    ctx.body({ type: "static", x: 10, y: 0.8, angle: 0.5, shape: { kind: "capsule", half: 0.9, r: 0.35 } });
    // a big slab (Rectangle shape path) rotated 30 degrees
    ctx.body({ type: "static", x: 0, y: -5.4, angle: 0.3, shape: { kind: "box", hx: 2.6, hy: 0.3 } });
  },
};

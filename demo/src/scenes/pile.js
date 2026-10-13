import { bin, randomBody } from "./common.js";

export default {
  name: "pile",
  title: "Pile",
  description: "420 boxes, circles and capsules fall into a bin. Bodies that fall asleep turn dark (move flag fellAsleep). Click to drop more.",
  gravity: [0, -10],
  view: { cx: 0, cy: 12, w: 38, h: 28 },
  create(ctx) {
    bin(ctx, 17, 26);
    const cols = 28, rows = 15;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        randomBody(ctx, -16.2 + c * 1.2 + ctx.range(-0.05, 0.05), 1.5 + r * 1.3);
      }
    }
  },
  onClick(ctx, x, y) {
    for (let i = 0; i < 8; i++) randomBody(ctx, x + ctx.range(-1.5, 1.5), y + i * 1.1);
  },
};

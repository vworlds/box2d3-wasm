import pile from "./pile.js";
import joints from "./joints.js";
import sensors from "./sensors.js";
import drift from "./drift.js";
import boxes from "./boxes.js";

// A scene module: { name, title, description, gravity, sleep?, view:{cx,cy,w,h} (metres),
//   create(ctx), update?(ctx, step), onClick?(ctx, x, y), destroy?(ctx) }
export const scenes = [pile, joints, sensors, drift, boxes];

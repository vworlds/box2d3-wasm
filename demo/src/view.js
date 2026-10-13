// The ONE place that maps Box2D (metres, y up, counter-clockwise radians) to Phaser (pixels, y down,
// clockwise radians). Everything that moves a game object or reads a pointer goes through here.
export const PPM = 32; // pixels per metre at camera zoom 1

/** Move a game object to a physics pose. */
export function place(obj, x, y, angle) {
  obj.x = x * PPM;
  obj.y = -y * PPM; // y flip
  obj.rotation = -angle; // so the angle flips too
}

/** Phaser world pixels -> physics metres. */
export const pxToX = (px) => px / PPM;
export const pxToY = (py) => -py / PPM;

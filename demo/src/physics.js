// Loads the wasm module and the fast-path helper. These two specifiers are resolved by the alias
// in vite.config.js.
import createBox2D from "box2d3-wasm";
import { createFastPath } from "box2d3-wasm/fastpath";

/**
 * Which flavour entry.mjs picked, read from the .wasm file the page actually fetched
 * (Box2D.deluxe-*.wasm or Box2D.compat-*.wasm). Falls back to "unknown" if the resource timing
 * buffer has no such entry (it is never guessed).
 */
function loadedFlavour() {
  const names = performance.getEntriesByType("resource").map((e) => e.name);
  for (const flavour of ["deluxe", "compat"]) {
    if (names.some((n) => new RegExp(`Box2D\\.${flavour}[^/]*\\.wasm`).test(n))) return flavour;
  }
  return "unknown";
}

export async function initPhysics() {
  const b2 = await createBox2D();
  const flavour = loadedFlavour();
  const fp = createFastPath(b2);
  fp.setProfileTimers(false); // Box2D's timers only feed b2World_GetProfile; off = no JS clock calls per step
  fp.sync();
  return { b2, fp, flavour };
}

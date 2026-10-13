import Phaser from "phaser";
import { initPhysics } from "./physics.js";
import { Sim } from "./sim.js";
import { scenes } from "./scenes/index.js";
import { PPM, pxToX, pxToY } from "./view.js";

const $ = (id) => document.getElementById(id);
const errors = [];
window.addEventListener("error", (e) => errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason?.stack ?? e.reason)));

function fatal(err) {
  console.error(err);
  errors.push(String(err?.stack ?? err));
  $("fatal").hidden = false;
  $("fatal").textContent = String(err?.stack ?? err);
}

class DemoScene extends Phaser.Scene {
  constructor() {
    super("demo");
    this.sim = null;
    this.userZoomed = false;
  }

  create() {
    this.cameras.main.setBackgroundColor(0x11151c);
    const cam = this.cameras.main;

    // pan with drag, zoom with the wheel, click (no drag) = the scene's onClick
    let down = null;
    this.input.on("pointerdown", (p) => { down = { x: p.x, y: p.y, moved: 0 }; });
    this.input.on("pointermove", (p) => {
      if (!down || !p.isDown) return;
      const dx = p.x - down.x, dy = p.y - down.y;
      down.moved += Math.abs(dx) + Math.abs(dy);
      down.x = p.x; down.y = p.y;
      cam.scrollX -= dx / cam.zoom;
      cam.scrollY -= dy / cam.zoom;
      if (down.moved > 6) this.userZoomed = true;
    });
    this.input.on("pointerup", (p) => {
      if (down && down.moved <= 6 && this.sim) this.sim.scene.onClick?.(this.sim, pxToX(p.worldX), pxToY(p.worldY));
      down = null;
    });
    this.input.on("wheel", (_p, _o, _dx, dy) => {
      cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.05, 20));
      this.userZoomed = true;
    });
    this.scale.on("resize", () => { if (!this.userZoomed) this.fit(); });

    this.registry.get("ready")(this);
  }

  /** Frame the scene's `view` rectangle (metres) in the canvas. */
  fit() {
    const v = this.sim?.scene.view;
    if (!v) return;
    const cam = this.cameras.main;
    // keep the camera clear of the top bar and the bottom stats panel
    const top = 48, bottom = 112;
    cam.setViewport(0, top, this.scale.width, Math.max(100, this.scale.height - top - bottom));
    cam.setZoom(Math.min(cam.width / (v.w * PPM), cam.height / (v.h * PPM)));
    cam.centerOn(v.cx * PPM, -v.cy * PPM); // metres, y up -> pixels, y down
  }

  loadDemo(scene, physics) {
    this.sim?.destroy();
    this.sim = null;
    const sim = new Sim({ ...physics, phaser: this, scene });
    scene.create(sim);
    this.sim = sim;
    this.userZoomed = false;
    this.fit();
    sim.refreshStats();
  }

  update(_time, delta) {
    this.sim?.update(delta);
  }
}

async function main() {
  const physics = await initPhysics();
  const { fp, flavour } = physics;

  const game = await new Promise((resolve) => {
    const g = new Phaser.Game({
      type: new URLSearchParams(location.search).get("renderer") === "canvas" ? Phaser.CANVAS : Phaser.AUTO, // ?renderer=canvas forces the 2D canvas renderer
      parent: "game",
      backgroundColor: "#11151c",
      scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
      scene: DemoScene,
      callbacks: { preBoot: (game) => game.registry.set("ready", (scene) => resolve({ g, scene })) },
    });
  });
  const phaserScene = game.scene;

  const picker = $("picker");
  const buttons = new Map();
  let current = null;

  function select(name) {
    const scene = scenes.find((s) => s.name === name) ?? scenes[0];
    phaserScene.loadDemo(scene, physics);
    current = scene;
    $("desc").textContent = scene.description;
    for (const [n, b] of buttons) b.setAttribute("aria-current", String(n === scene.name));
    history.replaceState(null, "", `#${scene.name}`);
  }

  for (const s of scenes) {
    if (s.hidden) continue;
    const b = document.createElement("button");
    b.textContent = s.title;
    b.onclick = () => select(s.name);
    picker.append(b);
    buttons.set(s.name, b);
  }

  // stats readout, a few times a second
  setInterval(() => {
    const sim = phaserScene.sim;
    if (!sim) return;
    sim.refreshStats();
    const s = sim.stats;
    $("stats").textContent =
      `bodies ${s.bodies}   awake ${s.awake}\n` +
      `step ${s.stepMs.toFixed(2)} ms   export ${s.exportMs.toFixed(2)} ms   moves/step ${s.moves}   hits/step ${s.hits}` +
      (sim.info ? `\n${sim.info}` : "") +
      `\nwasm ${flavour}   ${game.g.renderer.type === Phaser.WEBGL ? "WebGL" : "Canvas"}  ${Math.round(game.g.loop.actualFps)} fps`;
  }, 250);

  // small hook for the headless checks
  window.__demo = {
    errors,
    flavour,
    renderer: () => (game.g.renderer.type === Phaser.WEBGL ? "webgl" : "canvas"),
    select,
    get scene() { return current?.name; },
    get sim() { return phaserScene.sim; },
    get stats() { return { ...phaserScene.sim.stats }; },
    /** Positions (m) of the first `n` dynamic bodies, as the move records last reported them. */
    sample(n = 50) {
      return phaserScene.sim.entities.filter((e) => e && e.type !== "static").slice(0, n).map((e) => [e.x, e.y, e.angle]);
    },
    /** Sprite pixel positions of the same bodies (what is actually drawn). */
    spritePos(n = 50) {
      return phaserScene.sim.entities.filter((e) => e && e.type !== "static").slice(0, n).map((e) => [e.visual.x, e.visual.y, e.visual.rotation]);
    },
    wasmBytes: () => fp.memory.buffer.byteLength,
    objects: () => phaserScene.children.length,
  };

  select(location.hash.slice(1) || scenes[0].name);
}

main().catch(fatal);

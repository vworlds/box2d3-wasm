// Headless check of the BUILT demo site (dist-site/). Serves it on a random localhost port under a
// subpath (like https://<org>.github.io/<repo>/), opens every scene in Chrome and asserts that
//   - there are no page errors, console errors or failed/4xx requests,
//   - the scene has bodies, and sampled body positions change over time,
//   - sprite positions follow the physics positions (what is drawn is what was simulated),
//   - the wasm flavour shown in the stats readout is the expected one,
//   - switching scenes repeatedly does not grow wasm memory.
//
// Environment:
//   CHROME_PATH   Chrome/Chromium executable (default: puppeteer looks for an installed Chrome)
//   RENDERER      "webgl" (default) or "canvas" (adds ?renderer=canvas)
//   SHOTS_DIR     where screenshots go (default: a fresh temp dir, printed at the end)
//   CHROME_ARGS   space separated extra Chrome flags; replaces the default software-GL flags
//   EXPECT_FLAVOUR  "deluxe" (default) or "compat"
//
// Run `npm run build` first, then `npm run check`.
import http from "node:http";
import { readFile, mkdtemp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer-core";

const root = resolve(import.meta.dirname, "../dist-site");
if (!existsSync(join(root, "index.html"))) {
  console.error(`${root} not found: run "npm run build" in demo/ first`);
  process.exit(2);
}
const PREFIX = "/box2d3-wasm-demo"; // the site is served below this path, like a GitHub Pages project site
const renderer = process.env.RENDERER ?? "webgl";
const expectFlavour = process.env.EXPECT_FLAVOUR ?? "deluxe";
const shotsDir = process.env.SHOTS_DIR ?? (await mkdtemp(join(tmpdir(), "box2d3-demo-shots-")));
await mkdir(shotsDir, { recursive: true });
const PPM = 32; // keep in sync with src/view.js

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm" };
const server = http.createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(req.url.split("?")[0]);
    if (!path.startsWith(`${PREFIX}/`)) { res.writeHead(404); return res.end("outside the subpath"); }
    const rel = path.slice(PREFIX.length) === "/" ? "/index.html" : path.slice(PREFIX.length);
    const file = resolve(root, `.${rel}`);
    if (!file.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "content-length": data.length });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const launch = { headless: true };
if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
else launch.channel = "chrome";
launch.args = process.env.CHROME_ARGS
  ? ["--no-sandbox", ...process.env.CHROME_ARGS.split(/\s+/).filter(Boolean)]
  : ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  FAIL ${msg}`); };
let browser;
try {
  browser = await puppeteer.launch(launch);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const bad = [];
  page.on("pageerror", (e) => bad.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => bad.push(`requestfailed: ${r.url()}`));
  page.on("response", (r) => { if (r.status() >= 400) bad.push(`http ${r.status()} ${r.url()}`); });
  page.on("console", (m) => { if (m.type() === "error") bad.push(`console.error: ${m.text()}`); });

  const query = renderer === "canvas" ? "?renderer=canvas" : "";
  await page.goto(`http://127.0.0.1:${port}${PREFIX}/${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__demo?.sim, { timeout: 60000 });

  const env = await page.evaluate(() => ({ flavour: window.__demo.flavour, renderer: window.__demo.renderer() }));
  console.log(`site http://127.0.0.1:${port}${PREFIX}/  wasm flavour: ${env.flavour}  renderer: ${env.renderer}`);
  if (env.flavour !== expectFlavour) fail(`wasm flavour is ${env.flavour}, expected ${expectFlavour}`);
  if (env.renderer !== renderer) fail(`renderer is ${env.renderer}, expected ${renderer}`);

  // name, ms to let it run before the second sample, whether bodies are expected to move
  const scenes = [["pile", 2500, true], ["joints", 2500, true], ["sensors", 2500, true], ["drift", 2500, true], ["boxes", 800, false]];
  for (const [name, ms, moving] of scenes) {
    console.log(`scene ${name}`);
    const before = bad.length;
    await page.evaluate((n) => window.__demo.select(n), name);
    await sleep(400);
    const a = await page.evaluate(() => window.__demo.sample(60));
    await sleep(ms);
    const b = await page.evaluate(() => window.__demo.sample(60));
    const st = await page.evaluate(() => { window.__demo.sim.refreshStats(); return { ...window.__demo.stats, text: document.getElementById("stats").textContent }; });

    if (!(st.bodies > 0)) fail(`${name}: no bodies`);
    if (moving) {
      const n = Math.min(a.length, b.length);
      let moved = 0;
      for (let i = 0; i < n; i++) if (Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]) > 0.01) moved++;
      console.log(`  bodies ${st.bodies}, moved ${moved}/${n} sampled`);
      if (n === 0 || moved === 0) fail(`${name}: sampled positions did not change`);
    } else {
      console.log(`  bodies ${st.bodies}, static test scene`);
    }
    // sprites vs physics: both read in one evaluate so no step can happen in between
    const pair = await page.evaluate(() => ({ s: window.__demo.spritePos(60), p: window.__demo.sample(60) }));
    let worst = 0;
    for (let i = 0; i < pair.p.length; i++) {
      const [x, y, ang] = pair.p[i], [sx, sy, rot] = pair.s[i];
      worst = Math.max(worst, Math.abs(sx - x * PPM), Math.abs(sy + y * PPM), Math.abs(rot + ang));
    }
    if (pair.s.length !== pair.p.length) fail(`${name}: sprite/body count mismatch`);
    if (pair.p.length && worst > 1e-3) fail(`${name}: sprite differs from physics by ${worst}`);
    if (!st.text.includes(`wasm ${expectFlavour}`)) fail(`${name}: stats readout does not show "wasm ${expectFlavour}": ${JSON.stringify(st.text)}`);
    await page.screenshot({ path: join(shotsDir, `${renderer}-${name}.png`) });
    const mine = bad.slice(before);
    if (mine.length) fail(`${name}: ${[...new Set(mine)].join("; ")}`);
  }

  // click in every picker scene: spawns or pushes bodies without errors
  for (const name of ["pile", "joints", "sensors", "drift"]) {
    await page.evaluate((n) => window.__demo.select(n), name);
    await sleep(500);
    const before = await page.evaluate(() => window.__demo.sim.live);
    await page.mouse.click(640, 300);
    await sleep(300);
    const after = await page.evaluate(() => window.__demo.sim.live);
    console.log(`click ${name}: bodies ${before} -> ${after}`);
    if (name !== "drift" && after <= before) fail(`${name}: click did not add bodies`);
  }

  // switch through all scenes repeatedly; wasm memory must settle (no growth cycle over cycle)
  const mem = [];
  for (let round = 0; round < 5; round++) {
    for (const [name] of scenes) {
      await page.evaluate((n) => window.__demo.select(n), name);
      await sleep(500);
    }
    mem.push(await page.evaluate(() => ({ wasm: window.__demo.wasmBytes(), children: window.__demo.objects() })));
  }
  console.log("after each full cycle:", JSON.stringify(mem));
  if (mem[mem.length - 1].wasm > mem[1].wasm) fail(`wasm memory grew between cycle 2 and ${mem.length}`);
  if (mem[mem.length - 1].children > mem[1].children) fail("Phaser child count grew over cycles");

  const all = await page.evaluate(() => window.__demo.errors);
  if (all.length) fail(`window errors: ${all.join("; ")}`);
  if (bad.length) fail(`bad events: ${[...new Set(bad)].join("; ")}`);
} catch (e) {
  fail(`check crashed: ${e.stack ?? e}`);
} finally {
  await browser?.close();
  server.close();
}
console.log(`screenshots: ${shotsDir}`);
console.log(failures.length ? `RESULT: FAIL (${failures.length})` : "RESULT: PASS");
process.exit(failures.length ? 1 : 0);

// npm run test:stock: runs the scenes in diff.mjs on the stock box2d3-wasm package (embind) and on
// dist/ (embind and fast path, both flavours), then cmp.mjs fails unless every step hash matches.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../..");
const stockEs = resolve(root, "node_modules/box2d3-wasm/build/dist/es");
const distEs = resolve(root, "dist");
const out = resolve(root, "build/stock-differential");

if (!existsSync(resolve(stockEs, "deluxe/Box2D.deluxe.mjs"))) {
  console.error("stock box2d3-wasm 5.2.0 not found; run `npm install` first");
  process.exit(2);
}
if (!existsSync(resolve(distEs, "deluxe/Box2D.deluxe.mjs"))) {
  console.error("dist/ not built; run `npm run build` or `npm run build:docker` first");
  process.exit(2);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const run = (script, args) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [resolve(here, script), ...args], { stdio: "inherit" });
    child.on("exit", (code) => done(code ?? 1));
  });

const jobs = [];
for (const flavour of ["deluxe", "compat"]) {
  jobs.push(["stock", stockEs, flavour, "embind"]);
  jobs.push(["fork", distEs, flavour, "embind"]);
  jobs.push(["fork", distEs, flavour, "fast"]);
}
const codes = await Promise.all(
  jobs.map(([who, es, flavour, mode]) =>
    run("diff.mjs", [es, flavour, mode, resolve(out, `${who}-${flavour}-${mode}.json`)]),
  ),
);
if (codes.some((c) => c !== 0)) {
  console.error("a scene run failed");
  process.exit(1);
}
process.exit(await run("cmp.mjs", [out]));

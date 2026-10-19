// npm run test:reference: runs the scenes in diff.mjs on dist/ (embind and fast path, both
// flavours), then cmp.mjs fails unless every step hash matches the reference recorded for the
// pinned Box2D (reference/box2d-<pin>.json). See README.md.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// The reference for the pinned Box2D, and the one for the previous pin (reported, not enforced).
export const CURRENT = "box2d-v3.2.0.json";
export const PREVIOUS = "box2d-3a4f0da.json";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../..");
const distEs = resolve(root, "dist");
const out = resolve(root, "build/reference-differential");

if (!existsSync(resolve(distEs, "deluxe/Box2D.deluxe.mjs"))) {
  console.error("dist/ not built; run `npm run build` or `npm run build:docker` first");
  process.exit(2);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

let pin = null;
try {
  pin = execFileSync("git", ["-C", resolve(root, "box2d"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  // not a git checkout (e.g. a source tarball): cmp.mjs skips the pin check
}

const run = (script, args) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [resolve(here, script), ...args], { stdio: "inherit" });
    child.on("exit", (code) => done(code ?? 1));
  });

const jobs = [];
for (const flavour of ["deluxe", "compat"]) {
  for (const mode of ["embind", "fast"]) jobs.push([flavour, mode]);
}
const codes = await Promise.all(
  jobs.map(([flavour, mode]) => run("diff.mjs", [distEs, flavour, mode, resolve(out, `fork-${flavour}-${mode}.json`)])),
);
if (codes.some((c) => c !== 0)) {
  console.error("a scene run failed");
  process.exit(1);
}
const ref = resolve(here, "reference");
process.exit(await run("cmp.mjs", [out, resolve(ref, CURRENT), resolve(ref, PREVIOUS), pin ?? ""]));

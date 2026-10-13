// Fails unless `npm pack --dry-run` would publish only dist/ files, package.json, README.md,
// LICENSE and THIRD_PARTY_NOTICES.md, and the files the package.json exports point to are in it.
// Usage: node scripts/check-pack.mjs        (needs dist/ to be built)
import { execFileSync } from "node:child_process";

const allowedTop = new Set(["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]);
const required = [
  "package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md",
  "dist/entry.mjs", "dist/entry.d.ts", "dist/fastpath.mjs", "dist/fastpath.d.ts",
  "dist/deluxe/Box2D.deluxe.mjs", "dist/deluxe/Box2D.deluxe.wasm",
  "dist/compat/Box2D.compat.mjs", "dist/compat/Box2D.compat.wasm",
];

const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const files = JSON.parse(out)[0].files.map((f) => f.path);

const unexpected = files.filter((p) => !(allowedTop.has(p) || p.startsWith("dist/")));
const missing = required.filter((p) => !files.includes(p));
if (unexpected.length || missing.length) {
  if (unexpected.length) console.error(`unexpected files in the package:\n  ${unexpected.join("\n  ")}`);
  if (missing.length) console.error(`missing files in the package:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
console.log(`pack content ok: ${files.length} files (${files.filter((p) => p.startsWith("dist/")).length} in dist/)`);

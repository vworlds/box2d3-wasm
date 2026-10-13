import { defineConfig } from "vite";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// The ONLY place that knows where the physics package lives. The demo imports it as
// `box2d3-wasm` and `box2d3-wasm/fastpath`.
//
// In this repository the package is the repo root (output in dist/, exports "." and "./fastpath").
// BOX2D_PKG_DIR overrides the directory.
const PKG_DIR = process.env.BOX2D_PKG_DIR ?? resolve(import.meta.dirname, "..");
const ENTRY = "dist/entry.mjs";
const FASTPATH = "dist/fastpath.mjs";

for (const f of [ENTRY, FASTPATH]) {
  if (!existsSync(resolve(PKG_DIR, f))) {
    throw new Error(`${resolve(PKG_DIR, f)} not found: build the package first: npm run build (in ${PKG_DIR})`);
  }
}

export default defineConfig({
  base: "./", // relative, so the site works under https://<org>.github.io/<repo>/
  resolve: {
    alias: [
      { find: /^box2d3-wasm\/fastpath$/, replacement: resolve(PKG_DIR, FASTPATH) },
      { find: /^box2d3-wasm$/, replacement: resolve(PKG_DIR, ENTRY) },
    ],
  },
  server: { fs: { allow: [".", PKG_DIR] } },
  // Keep the emscripten glue out of esbuild pre-bundling so `new URL("*.wasm", import.meta.url)`
  // stays relative to the glue file and Vite can emit the .wasm.
  optimizeDeps: { exclude: ["box2d3-wasm"] },
  build: { outDir: "dist-site", emptyOutDir: true, chunkSizeWarningLimit: 2000, target: "es2022" },
});

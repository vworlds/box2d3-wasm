// Spike (measurement only): price of a raw wasm export call and of typed-array reads, and what
// happens to views when memory grows. BOX2D_ENTRY=<entry.mjs> node perf/spikes/raw-crossing.mjs
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { cpus } from "node:os";
globalThis.navigator ??= {};
globalThis.navigator.hardwareConcurrency ??= cpus().length;
const { default: factory } = await import(pathToFileURL(resolve(process.env.BOX2D_ENTRY)).href);
const b = await factory();
let sink = 0;
function bench(name, n, fn) {
  for (let i = 0; i < 20000; i++) fn(i);
  const t = performance.now();
  for (let i = 0; i < n; i++) fn(i);
  console.log(`${(((performance.now() - t) * 1e6) / n).toFixed(1).padStart(8)} ns  ${name}`);
}
const ptr = b._malloc(1 << 20);
const f32 = new Float32Array(b.HEAPU8.buffer, ptr, 1 << 18);
for (let i = 0; i < f32.length; i++) f32[i] = i * 0.5;
const whole = new Float32Array(b.HEAPU8.buffer);
const base = ptr >> 2;
bench("raw export call: _free(0)", 5e6, () => b._free(0));
bench("Float32Array read (region view)", 2e7, (i) => (sink += f32[i & 0x3ffff]));
bench("Float32Array read (whole-memory view, base+i)", 2e7, (i) => (sink += whole[base + (i & 0x3ffff)]));
bench("b.HEAPU8.buffer access", 5e6, () => (sink += b.HEAPU8.buffer.byteLength));
const sab = b.HEAPU8.buffer;
console.log("shared:", typeof SharedArrayBuffer !== "undefined" && sab instanceof SharedArrayBuffer, "byteLength", sab.byteLength);
const before = b.HEAPU8;
const big = b._malloc(256 << 20); // forces growth
console.log("after 256MB malloc: Module.HEAPU8 replaced?", before !== b.HEAPU8, "new byteLength", b.HEAPU8.buffer.byteLength);
console.log("old region view still reads:", f32.length, f32[123] === 61.5, "old whole view length", whole.length);
f32[7] = 42.25;
console.log("old view write visible through new view:", new Float32Array(b.HEAPU8.buffer)[base + 7] === 42.25);
b._free(big);
if (sink === 0.5) console.log(sink);

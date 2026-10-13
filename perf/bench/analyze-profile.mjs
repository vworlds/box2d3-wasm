// Ranked cost table from a .cpuprofile of perf/bench/vecs-tick.ts.
//
//   node perf/bench/analyze-profile.mjs <file.cpuprofile> [--top 40] [--json out.json]
//
// Only samples whose stack passes through `progressAll` (the measured tick loop) count. Self time
// is bucketed into categories:
//   embind-js     JS glue in Box2D.*.mjs (handle creation, invokers, wire-type conversion)
//   embind-wasm   C++ binding glue inside wasm (emscripten::internal, invokers, value_object
//                 ctor/getter/setter thunks, operator new/delete, malloc/free, memcpy)
//   wasm-alloc    malloc/free and the allocator's pthread mutex (embind's temporaries)
//   box2d         Box2D's own C code inside wasm (simulation, events)
//   vecs-physics  the vecs-physics adapter (lib/vecs-physics/dist)
//   vecs          vecs core (lib/vecs/dist)
//   gc            (garbage collector)
//   engine        (program) and other V8-internal frames
//   bench         the benchmark harness itself
// and attributed to the physics system it ran under (PhysicsPoseSyncOut, PhysicsStep,
// PhysicsEvents, other).
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
const top = Number(argValue("--top", 40));
const jsonOut = argValue("--json");
const profile = JSON.parse(readFileSync(file, "utf8"));

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
for (const n of profile.nodes) for (const c of n.children ?? []) byId.get(c).parent = n.id;

const SYSTEMS = ["PhysicsPoseSyncOut", "PhysicsStep", "PhysicsEvents"];
const SYSTEM_URL_HINTS = [
  ["PhysicsPoseSyncOut", /body\/pose_out\.js$/],
  ["PhysicsStep", /core\/step\.js$/],
  ["PhysicsEvents", /events\/publish\.js$/],
];

// Per node: in tick loop?, which system, category.
const info = new Map();
function nodeInfo(id) {
  let cached = info.get(id);
  if (cached) return cached;
  const n = byId.get(id);
  const parent = n.parent !== undefined ? nodeInfo(n.parent) : { inTick: false, system: "other" };
  let inTick = parent.inTick || n.callFrame.functionName === "progressAll";
  let system = parent.system;
  if (system === "other") {
    for (const [name, re] of SYSTEM_URL_HINTS) if (re.test(n.callFrame.url)) system = name;
  }
  cached = { inTick, system, category: categorize(n.callFrame) };
  info.set(id, cached);
  return cached;
}

function categorize(frame) {
  const { url, functionName: fn } = frame;
  if (fn === "(garbage collector)") return "gc";
  if (fn === "(program)" || fn === "(root)") return "engine";
  if (fn === "(idle)") return "idle";
  if (url.startsWith("wasm://") || /^\$?(wasm-function|js-to-wasm|wasm-to-js)/.test(fn)) {
    if (/malloc|free|pthread_mutex|sbrk|dlmalloc|operator new|operator delete|operator_new|operator_delete/.test(fn)) {
      return "wasm-alloc";
    }
    return isBindingWasm(fn) ? "embind-wasm" : "box2d";
  }
  if (/Box2D\.[a-z]+\.mjs$/.test(url)) return "embind-js";
  if (/vecs-physics\/dist\//.test(url)) return "vecs-physics";
  if (/\/lib\/vecs\/dist\//.test(url) || /\/lib\/vecs\/dist$/.test(url)) return "vecs";
  if (/perf\/bench\//.test(url)) return "bench";
  if (url === "") return "engine";
  return "engine";
}

function isBindingWasm(fn) {
  return (
    /emscripten|embind|Invoker|MethodInvoker|FunctionInvoker|GenericBindingType|BindingType|raw_constructor|raw_destructor|get_by_value|set_by_value|MemberAccess|getContext|operator new|operator delete|^_Znw|^_Zdl|^_Zn|malloc|free|dlmalloc|sbrk|memcpy|memset|memmove|^\$?_?_?wasm_call_ctors|js-to-wasm|wasm-to-js|lambda|\$_\d|_\$_\d|__invoke|ClassHandle|AllowedRawPointer|std::__2/.test(
      fn
    ) && (/emscripten::|js-to-wasm|wasm-to-js/.test(fn) || !/^b2[A-Z]/.test(fn))
  );
}

const dts = profile.timeDeltas;
const totals = new Map();
const bySystem = new Map();
const byFunction = new Map();
let tickUs = 0;
// GC and (program) samples hang off the root, outside any JS stack, so they never pass through
// progressAll. Count the ones that fall inside the tick loop's time window (first to last
// tick-loop sample): after setup, the loop is all the process does.
let firstTick = -1;
let lastTick = -1;
for (let i = 0; i < profile.samples.length; i++) {
  if (nodeInfo(profile.samples[i]).inTick) {
    if (firstTick < 0) firstTick = i;
    lastTick = i;
  }
}
const ROOT_LEVEL = new Set(["(garbage collector)", "(program)"]);
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i];
  const dt = dts[i] ?? 0;
  const ni = nodeInfo(id);
  if (!ni.inTick) {
    const fn = byId.get(id).callFrame.functionName;
    if (i > firstTick && i < lastTick && ROOT_LEVEL.has(fn)) {
      const category = fn === "(garbage collector)" ? "gc" : "engine";
      tickUs += dt;
      add(totals, category, dt);
      add(bySystem, `${fn}\t${category}`, dt);
      add(byFunction, `${category}\t${fn}\t:0`, dt);
    }
    continue;
  }
  tickUs += dt;
  add(totals, ni.category, dt);
  add(bySystem, `${ni.system}\t${ni.category}`, dt);
  const frame = byId.get(id).callFrame;
  const where = frame.url ? frame.url.replace(/^.*\/(lib\/[^/]+\/dist\/|deluxe\/|compat\/|bench\/)/, "$1") : "";
  add(byFunction, `${ni.category}\t${frame.functionName || "(anon)"}\t${where}:${frame.lineNumber + 1}`, dt);
}

const pct = (us) => ((100 * us) / tickUs).toFixed(1).padStart(5) + "%";
console.log(`profile ${file}\ntick-loop samples: ${(tickUs / 1000).toFixed(0)} ms\n`);
console.log("== by category (self time)");
for (const [k, v] of sorted(totals)) console.log(`${pct(v)}  ${k}`);
console.log("\n== by system x category");
const systemTotals = new Map();
for (const [k, v] of bySystem) add(systemTotals, k.split("\t")[0], v);
for (const [system, total] of sorted(systemTotals)) {
  console.log(`${pct(total)}  ${system}`);
  for (const [k, v] of sorted(bySystem)) {
    const [s, cat] = k.split("\t");
    if (s === system) console.log(`    ${pct(v)}  ${cat}`);
  }
}
console.log(`\n== top ${top} functions (self time)`);
for (const [k, v] of sorted(byFunction).slice(0, top)) console.log(`${pct(v)}  ${k.replace(/\t/g, "  ")}`);

if (jsonOut) {
  const obj = (m) => Object.fromEntries(sorted(m).map(([k, v]) => [k, +((100 * v) / tickUs).toFixed(2)]));
  writeFileSync(
    jsonOut,
    JSON.stringify({ tickMs: tickUs / 1000, category: obj(totals), system: obj(bySystem), functions: obj(byFunction) }, null, 1)
  );
}

function add(m, k, v) {
  m.set(k, (m.get(k) ?? 0) + v);
}
function sorted(m) {
  return [...m].sort((a, b) => b[1] - a[1]);
}
function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
void SYSTEMS;

import { readFileSync } from "node:fs";
const L = (n) => JSON.parse(readFileSync(`${process.argv[2] ?? "out"}/${n}.json`, "utf8"));
let bad = 0, steps = 0, values = 0;
for (const fl of ["deluxe", "compat"]) {
  const ref = L(`stock-${fl}-embind`);
  for (const other of [`fork-${fl}-embind`, `fork-${fl}-fast`]) {
    const o = L(other);
    for (const [name, r] of Object.entries(ref.scenes)) {
      const s = o.scenes[name];
      const first = r.steps.findIndex((h, i) => h !== s.steps[i]);
      const ok = r.sha === s.sha && first === -1 && r.steps.length === s.steps.length && r.values === s.values;
      if (!ok) bad++;
      steps += r.steps.length; values += r.values;
      console.log(`${ok ? "IDENTICAL" : "DIFFERENT"}  stock-${fl}-embind vs ${other.padEnd(20)} ${name.padEnd(10)} ${r.steps.length} steps ${r.values} values sha ${r.sha.slice(0, 12)}${ok ? "" : ` vs ${s.sha.slice(0, 12)} first differing step ${first}`}`);
    }
  }
}
const d = L("stock-deluxe-embind"), c = L("stock-compat-embind");
console.log("deluxe vs compat (stock):", Object.keys(d.scenes).map((n) => `${n}:${d.scenes[n].sha === c.scenes[n].sha ? "same" : "differ"}`).join(" "));
console.log(`${bad} differing comparisons; ${steps} step hashes, ${values} values compared`);
process.exit(bad ? 1 : 0);

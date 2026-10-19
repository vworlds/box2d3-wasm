// cmp.mjs <out dir> <current reference> <previous reference> [box2d commit]
// Fails unless every run in <out dir> has exactly the step hashes of <current reference>.
// The previous reference is only reported: which scenes changed with the Box2D update, and from
// which step.
import { readFileSync } from "node:fs";

const [outDir, currentFile, previousFile, pin] = process.argv.slice(2);
const L = (f) => JSON.parse(readFileSync(f, "utf8"));
const ref = L(currentFile);
const prev = L(previousFile);

if (pin && pin !== ref.box2d.commit) {
  console.error(
    `reference ${currentFile} was recorded for Box2D ${ref.box2d.commit} (${ref.box2d.tag}), but the box2d ` +
      `submodule is at ${pin}. Record a new reference: see docs/box2d-update.md.`,
  );
  process.exit(1);
}

let bad = 0, steps = 0, values = 0;
for (const fl of ["deluxe", "compat"]) {
  for (const mode of ["embind", "fast"]) {
    const name = `fork-${fl}-${mode}`;
    const o = L(`${outDir}/${name}.json`);
    for (const [scene, r] of Object.entries(ref.scenes)) {
      const s = o.scenes[scene];
      const first = r.steps.findIndex((h, i) => h !== s.steps[i]);
      const ok = r.sha === s.sha && first === -1 && r.steps.length === s.steps.length && r.values === s.values;
      if (!ok) bad++;
      steps += r.steps.length;
      values += r.values;
      console.log(
        `${ok ? "IDENTICAL" : "DIFFERENT"}  reference vs ${name.padEnd(18)} ${scene.padEnd(10)} ${r.steps.length} steps ${r.values} values sha ${r.sha.slice(0, 12)}${ok ? "" : ` vs ${s.sha.slice(0, 12)} first differing step ${first}`}`,
      );
    }
  }
}

console.log(`\nchanges since the previous Box2D (${prev.box2d.tag}, not enforced):`);
for (const [scene, r] of Object.entries(ref.scenes)) {
  const p = prev.scenes[scene];
  if (!p) {
    console.log(`  ${scene.padEnd(10)} new scene`);
    continue;
  }
  const first = r.steps.findIndex((h, i) => h !== p.steps[i]);
  console.log(`  ${scene.padEnd(10)} ${first === -1 ? "unchanged" : `differs from step ${first}`}`);
}
console.log(`${bad} differing comparisons; ${steps} step hashes, ${values} values compared against ${ref.box2d.tag}`);
process.exit(bad ? 1 : 0);

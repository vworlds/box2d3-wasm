// node --test scripts/release-version.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { decide, nextPatch } from "./release-version.mjs";

const published = (...versions) => async (_n, v) => versions.includes(v);
const name = "@vworlds/box2d3-wasm";

test("an unpublished version is released as is", async () => {
  const r = await decide({ name, version: "6.0.0", isPublished: published() });
  assert.deepEqual([r.version, r.bumped], ["6.0.0", false]);
});

test("a published version gets its patch bumped", async () => {
  const r = await decide({ name, version: "6.0.0", isPublished: published("6.0.0") });
  assert.deepEqual([r.version, r.bumped], ["6.0.1", true]);
});

test("a bumped version that is also published is an error", async () => {
  await assert.rejects(decide({ name, version: "6.0.0", isPublished: published("6.0.0", "6.0.1") }), /already on npm too/);
});

test("version format", async () => {
  assert.equal(nextPatch("1.2.9"), "1.2.10");
  assert.throws(() => nextPatch("1.2.3-beta.1"));
  await assert.rejects(decide({ name, version: "x", isPublished: published() }));
});

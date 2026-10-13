// Decides the version to release and writes it into package.json and package-lock.json.
//
//   node scripts/release-version.mjs [--dry-run]
//
// - The version in package.json is not on npm yet: release it as is (this is how 6.0.0 goes out).
// - It is already on npm: bump the patch version (x.y.z -> x.y.(z+1)), as vecs's
//   bump-vecs-versions.mjs does.
//
// Prints the decision to stderr and the version to release to stdout. With --dry-run nothing is
// written. When GITHUB_OUTPUT is set (and not a dry run) `version` and `bumped` are appended to it.
//
// RELEASE_VERSION_STUB_PUBLISHED="6.0.0,6.0.1" replaces the registry lookup (comma separated list
// of versions that count as published), so both branches can be run without the network.
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextPatch(version) {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`Unsupported version format: ${version} (expected x.y.z)`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

// isPublished(name, version) -> Promise<boolean>; injected so tests can stub the registry.
export async function decide({ name, version, isPublished }) {
  if (!SEMVER.test(version)) throw new Error(`Unsupported version format: ${version} (expected x.y.z)`);
  if (!(await isPublished(name, version))) {
    return { version, bumped: false, reason: `${name}@${version} is not on npm: release it as is` };
  }
  const next = nextPatch(version);
  if (await isPublished(name, next)) {
    throw new Error(`${name}@${next} is already on npm too; set the version in package.json by hand`);
  }
  return { version: next, bumped: true, reason: `${name}@${version} is already on npm: bump the patch version to ${next}` };
}

// 404 -> not published, 200 -> published, anything else (after retries) is an error: a registry
// outage must not look like "unpublished" and send a release down the wrong path.
export async function registryIsPublished(name, version) {
  const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}/${version}`;
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.status === 200) return true;
      if (res.status === 404) return false;
      last = new Error(`${url} answered HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  throw last;
}

function stubbedIsPublished(list) {
  const set = new Set(list.split(",").map((s) => s.trim()).filter(Boolean));
  return async (_name, version) => set.has(version);
}

async function writeVersion(version) {
  for (const path of ["package.json", "package-lock.json"]) {
    let data;
    try {
      data = JSON.parse(await readFile(path, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT" && path === "package-lock.json") continue;
      throw err;
    }
    data.version = version;
    if (data.packages?.[""]) data.packages[""].version = version;
    await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const stub = process.env.RELEASE_VERSION_STUB_PUBLISHED;
  const isPublished = stub !== undefined ? stubbedIsPublished(stub) : registryIsPublished;
  const result = await decide({ name: pkg.name, version: pkg.version, isPublished });

  console.error(`${dryRun ? "[dry run] " : ""}${result.reason}`);
  if (!dryRun) {
    if (result.bumped) await writeVersion(result.version);
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `version=${result.version}\nbumped=${result.bumped}\n`);
    }
  }
  console.log(result.version);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

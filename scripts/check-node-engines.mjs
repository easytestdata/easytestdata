#!/usr/bin/env node

// The supported Node version lives in the root package.json. Every workspace package must declare
// the same range, the preinstall guard must enforce its minimum, and every locked dependency must
// run on that minimum, so an upgrade cannot quietly need a newer Node than the project promises.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { parse } from "yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
const problems = [];

const range = JSON.parse(read("package.json")).engines?.node;
const minimum = range && semver.minVersion(range)?.version;
if (!minimum) {
  console.error(`check-node-engines: root package.json needs an engines.node range (got ${range})`);
  process.exit(1);
}

const lockfile = parse(read("pnpm-lock.yaml"));
for (const dir of Object.keys(lockfile.importers)) {
  if (dir === ".") continue;
  const manifest = JSON.parse(read(join(dir, "package.json")));
  const declared = manifest.engines?.node;
  if (declared === undefined) {
    problems.push(`${dir}/package.json has no engines.node; declare the root's "${range}"`);
  } else if (declared !== range) {
    problems.push(`${dir}/package.json declares engines.node "${declared}", root says "${range}"`);
  }
}

const guard = read("scripts/guard-node-version.mjs").match(/const MIN = \[(\d+), (\d+)\];/);
if (!guard) {
  problems.push("scripts/guard-node-version.mjs: could not find `const MIN = [major, minor];`");
} else if (`${guard[1]}.${guard[2]}.0` !== minimum) {
  problems.push(
    `scripts/guard-node-version.mjs enforces ${guard[1]}.${guard[2]}, root says ${minimum}`
  );
}

for (const [id, info] of Object.entries(lockfile.packages ?? {})) {
  const needs = info.engines?.node;
  if (needs && !semver.satisfies(minimum, needs)) {
    problems.push(`${id} needs Node ${needs}, but the project supports ${minimum}`);
  }
}

if (problems.length) {
  console.error(`check-node-engines: ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "Raise the minimum everywhere (root and package engines, the guard, the docs) or pick versions that support it."
  );
  process.exit(1);
}
console.log(`check-node-engines: every package and locked dependency runs on Node ${minimum}`);

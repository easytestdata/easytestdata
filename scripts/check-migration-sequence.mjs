#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, "../packages/server/src/db/migrations");
const files = fs
  .readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();

const prefixToFiles = new Map();
for (const file of files) {
  const match = file.match(/^(\d{3})_[a-z0-9_]+\.sql$/i);
  if (!match) {
    console.error(`[migrations] Invalid migration filename format: ${file}`);
    process.exit(1);
  }
  const prefix = match[1];
  if (!prefixToFiles.has(prefix)) {
    prefixToFiles.set(prefix, []);
  }
  prefixToFiles.get(prefix).push(file);
}

for (const [prefix, matchingFiles] of prefixToFiles.entries()) {
  if (matchingFiles.length > 1) {
    console.error(`[migrations] Duplicate migration prefix ${prefix}: ${matchingFiles.join(", ")}`);
    process.exit(1);
  }
}

const distinctPrefixes = Array.from(prefixToFiles.keys())
  .map((prefix) => Number.parseInt(prefix, 10))
  .sort((a, b) => a - b);

for (let i = 1; i < distinctPrefixes.length; i += 1) {
  const prev = distinctPrefixes[i - 1];
  const current = distinctPrefixes[i];
  if (current !== prev + 1) {
    console.error(
      `[migrations] Non-contiguous migration sequence: expected ${String(prev + 1).padStart(3, "0")} before ${String(current).padStart(3, "0")}`
    );
    process.exit(1);
  }
}

console.log(
  `[migrations] Sequence check passed (${files.length} files, ${distinctPrefixes.length} distinct prefixes).`
);

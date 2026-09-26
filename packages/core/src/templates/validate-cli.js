#!/usr/bin/env node

/**
 * CLI template validator — checks a new industry template (as JSON) before it is added to
 * templates/industries/data.js.
 *
 * Usage:
 *   node packages/core/src/templates/validate-cli.js my-template.json
 *   node packages/core/src/templates/validate-cli.js path/to/template.json
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { validateTemplate } from "./schema.js";

const file = process.argv[2];

if (!file) {
  console.error("Usage: node validate-cli.js <template.json>");
  console.error("");
  console.error("Validates an industry template JSON file against the EasyTestData schema.");
  console.error("");
  console.error("Example:");
  console.error("  node packages/core/src/templates/validate-cli.js my-template.json");
  process.exit(1);
}

const filePath = resolve(file);
let raw;
try {
  raw = readFileSync(filePath, "utf8");
} catch (err) {
  console.error(`Error reading file: ${err.message}`);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(raw);
} catch (err) {
  console.error(`Error parsing JSON: ${err.message}`);
  process.exit(1);
}

const result = validateTemplate(data);

if (result.valid) {
  console.log(`Valid template: "${data.name}"`);
  console.log(`  Service items: ${data.serviceItems.length}`);
  console.log(`  Expense categories: ${data.expenseCategories.length}`);
  if (data.ratios) {
    console.log(`  Ratio overrides: ${Object.keys(data.ratios).length}`);
  }
  process.exit(0);
} else {
  console.error(
    `Invalid template (${result.errors.length} error${result.errors.length === 1 ? "" : "s"}):`
  );
  for (const err of result.errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

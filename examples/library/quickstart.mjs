// Generate a year of books for a SaaS company and write one CSV per table.
// Run: node examples/library/quickstart.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportToCsv, generate } from "@easytestdata/core";

const quiet = process.argv.includes("--quiet");
const plan = generate({ template: "saas", preset: "rapid-growth", seed: 42, startDate: "2025-01-01" });

const outDir = join(import.meta.dirname, "output");
mkdirSync(outDir, { recursive: true });
for (const [table, csv] of Object.entries(exportToCsv(plan))) {
  writeFileSync(join(outDir, `${table}.csv`), csv);
}

if (!quiet) {
  console.log(`${plan.customers.length} customers, e.g. ${plan.customers[0].name}`);
  console.log(`${plan.invoices.length} invoices, ${plan.bills.length} bills`);
  console.log(`Revenue: $${plan.metrics.totalRevenueGenerated.toLocaleString()}`);
  console.log(`CSV files written to ${outDir}`);
}

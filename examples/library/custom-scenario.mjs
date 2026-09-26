// Tune a scenario: a struggling restaurant in Canada with slow-paying customers.
// Explicit options win over the preset, which wins over the defaults.
// Run: node examples/library/custom-scenario.mjs
import { exportToJson, generate } from "@easytestdata/core";

const quiet = process.argv.includes("--quiet");
const plan = generate({
  template: "restaurant",
  preset: "cash-crisis",
  country: "CA",
  totalRevenue: "850k",
  targetEbitda: "-40k",
  customerCount: 40,
  ratios: { invoicePaymentRate: 0.55 },
  seed: 7,
  startDate: "2025-01-01",
  months: 6
});

const json = exportToJson(plan);
if (!quiet) {
  console.log(`${plan.meta.startDate} to ${plan.meta.endDate}: ${plan.invoices.length} invoices`);
  console.log(`First vendor: ${plan.vendors[0].name}, ${plan.vendors[0].address.city}`);
  console.log(`JSON size: ${(json.length / 1024).toFixed(0)} KB`);
}

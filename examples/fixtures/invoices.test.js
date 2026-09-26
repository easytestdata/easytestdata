// Use EasyTestData as deterministic test fixtures. A fixed seed and start date give
// byte-identical data on every run, so assertions stay stable.
// Run: pnpm --filter @easytestdata/examples exec vitest run fixtures
import { describe, expect, it } from "vitest";
import { generate } from "@easytestdata/core";

const plan = generate({ template: "professional-services", seed: 1, startDate: "2025-01-01" });

describe("generated books", () => {
  it("is deterministic for a fixed seed and start date", () => {
    const again = generate({ template: "professional-services", seed: 1, startDate: "2025-01-01" });
    expect(JSON.stringify(again)).toBe(JSON.stringify(plan));
  });

  it("only invoices known customers", () => {
    const customers = new Set(plan.customers.map((c) => c.name));
    for (const invoice of plan.invoices) expect(customers.has(invoice.customerName)).toBe(true);
  });

  it("uses unique display names across customers, vendors, and employees", () => {
    const names = [...plan.customers, ...plan.vendors, ...plan.employees].map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

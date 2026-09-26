import { describe, expect, it } from "vitest";
import {
  generate,
  resolvePeriod,
  parseAmount,
  resolveConfig,
  resolveRequest,
  listScenarioPresets,
  listIndustryTemplates,
  exportToJson,
  countPeriodMonths,
  validateRatioOverrides,
  DEFAULT_REQUEST,
  RATIOS,
  RATIO_BOUNDS
} from "../src/index.js";

const FIXED = { startDate: "2025-01-01", months: 12, seed: 1 };

describe("generate() preset precedence", () => {
  it("every preset produces output different from the no-preset default", () => {
    const baseline = exportToJson(generate(FIXED));
    const outputs = new Set([baseline]);
    for (const { id } of listScenarioPresets()) {
      const json = exportToJson(generate({ ...FIXED, preset: id }));
      expect(json).not.toBe(baseline);
      outputs.add(json);
    }
    expect(outputs.size).toBe(listScenarioPresets().length + 1);
  });

  it("applies preset request values", () => {
    const plan = generate({ ...FIXED, preset: "rapid-growth" });
    expect(plan.metrics.totalRevenueRequested).toBe(2000000);
    expect(plan.customers).toHaveLength(90);
    expect(plan.employees).toHaveLength(30);
    expect(plan.meta.preset).toBe("rapid-growth");
  });

  it("applies preset ratio overrides", () => {
    const { ratioOverrides } = resolveRequest({ preset: "cash-crisis" });
    expect(ratioOverrides.invoicePaymentRate).toBe(0.62);
    const crisis = generate({ ...FIXED, preset: "cash-crisis", ratios: { partialPaymentRate: 1 } });
    // explicit ratio beats preset ratio
    expect(crisis.payments.every((p) => p.amount < crisis.invoices[p.invoiceIndex].amount)).toBe(
      true
    );
  });

  it("explicit values override the preset", () => {
    const plan = generate({ ...FIXED, preset: "rapid-growth", customerCount: 12 });
    expect(plan.customers).toHaveLength(12);
    expect(plan.employees).toHaveLength(30); // still from the preset
    const { request } = resolveRequest({ preset: "rapid-growth", totalRevenue: "1M" });
    expect(request.totalRevenue).toBe(1000000);
    // margin of the preset is preserved when only revenue is overridden
    expect(request.targetEbitda).toBe(60000);
  });

  it("falls back to defaults without a preset", () => {
    const { request } = resolveRequest({});
    expect(request).toEqual({ ...DEFAULT_REQUEST });
  });

  it("clamps an inherited top-customer count to an explicit customer count", () => {
    const plan = generate({ ...FIXED, customerCount: 2 });
    expect(plan.customers).toHaveLength(2);
  });

  it("supports negative EBITDA", () => {
    const plan = generate({ ...FIXED, totalRevenue: "1.5M", targetEbitda: "-50k" });
    expect(plan.metrics.ebitdaGenerated).toBeLessThan(0);
    expect(plan.metrics.totalExpensesGenerated).toBeGreaterThan(plan.metrics.totalRevenueGenerated);
  });

  it("is byte-identical for the same seed and dates", () => {
    const a = exportToJson(generate({ ...FIXED, template: "saas", preset: "seasonal" }));
    const b = exportToJson(generate({ ...FIXED, template: "saas", preset: "seasonal" }));
    expect(a).toBe(b);
  });

  it("draws a random seed when none is given and records it so the run can be reproduced", () => {
    const dates = { startDate: "2025-01-01", months: 12 };
    const plan = generate(dates);
    expect(Number.isInteger(plan.meta.seed)).toBe(true);
    expect(plan.meta.seed).toBeGreaterThanOrEqual(1);
    expect(plan.meta.seed).toBeLessThanOrEqual(0x7fffffff);
    // Passing the recorded seed back reproduces the run byte for byte.
    expect(exportToJson(generate({ ...dates, seed: plan.meta.seed }))).toBe(exportToJson(plan));
    // Seedless runs differ from each other (1 in 2^31 chance of a false failure).
    const seeds = new Set(Array.from({ length: 5 }, () => generate(dates).meta.seed));
    expect(seeds.size).toBeGreaterThan(1);
  });
});

describe("unknown names", () => {
  it("throws for an unknown template with the valid list", () => {
    expect(() => generate({ template: "bakery" })).toThrow(
      /Unknown industry template "bakery". Valid templates: professional-services, saas/
    );
    expect(() => resolveConfig("bakery")).toThrow(/Unknown industry template/);
  });

  it("throws for an unknown preset with the valid list", () => {
    expect(() => generate({ preset: "boom" })).toThrow(
      /Unknown scenario preset "boom". Valid presets: .*rapid-growth/
    );
  });

  it("throws for unknown ratio keys", () => {
    expect(() => resolveConfig("saas", { ratios: { invoicePaymentRat: 0.5 } })).toThrow(
      /Unknown ratio: invoicePaymentRat/
    );
  });

  it("resolveConfig accepts a template id", () => {
    expect(resolveConfig("saas").industry).toBe("saas");
  });
});

describe("resolvePeriod", () => {
  const today = new Date(2026, 8, 24); // 24 Sep 2026, local time

  it("defaults to the 12 full calendar months before today", () => {
    expect(resolvePeriod({ today })).toEqual({ startDate: "2025-09-01", endDate: "2026-08-31" });
  });

  it("honours months without dates", () => {
    expect(resolvePeriod({ months: 3, today })).toEqual({
      startDate: "2026-06-01",
      endDate: "2026-08-31"
    });
  });

  it("derives the end date from startDate + months", () => {
    expect(resolvePeriod({ startDate: "2025-01-01", months: 12 })).toEqual({
      startDate: "2025-01-01",
      endDate: "2025-12-31"
    });
    expect(resolvePeriod({ startDate: "2025-03-15", months: 1 }).endDate).toBe("2025-04-14");
  });

  it("clamps month arithmetic at month ends instead of rolling into the next month", () => {
    expect(resolvePeriod({ startDate: "2025-01-31", months: 1 }).endDate).toBe("2025-02-27");
    expect(resolvePeriod({ startDate: "2024-01-31", months: 1 }).endDate).toBe("2024-02-28");
    expect(resolvePeriod({ startDate: "2025-03-31", months: 11 }).endDate).toBe("2026-02-27");
    expect(resolvePeriod({ endDate: "2025-03-30", months: 1 }).startDate).toBe("2025-02-28");
  });

  it("applies the calendar-month bound to periods derived from months", () => {
    expect(resolvePeriod({ startDate: "2020-01-01", months: 120 }).endDate).toBe("2029-12-31");
    expect(() => resolvePeriod({ startDate: "2020-01-15", months: 120 })).toThrow(
      /spans 121 months; the maximum is 120/
    );
    expect(() => resolvePeriod({ endDate: "2029-12-30", months: 120 })).toThrow(/spans 121/);
  });

  it("derives the start date from endDate + months", () => {
    expect(resolvePeriod({ endDate: "2025-12-31", months: 6 }).startDate).toBe("2025-07-01");
  });

  it("uses explicit start and end dates as given", () => {
    expect(resolvePeriod({ startDate: "2024-02-01", endDate: "2024-02-29" })).toEqual({
      startDate: "2024-02-01",
      endDate: "2024-02-29"
    });
  });

  it("rejects bad input", () => {
    expect(() => resolvePeriod({ months: 0 })).toThrow(/months must be a whole number/);
    expect(() => resolvePeriod({ months: 2.5 })).toThrow(/months must be a whole number/);
    expect(() => resolvePeriod({ startDate: "2025-02-30" })).toThrow(/YYYY-MM-DD/);
    expect(() =>
      resolvePeriod({ startDate: "2025-01-01", endDate: "2025-02-01", months: 2 })
    ).toThrow(/at most two/);
  });
});

describe("parseAmount", () => {
  it.each([
    ["500k", 500000],
    ["1.5M", 1500000],
    ["2m", 2000000],
    ["1,000,000", 1000000],
    ["750000", 750000],
    ["-50k", -50000],
    [1234.5, 1234.5]
  ])("parses %s", (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it("rejects garbage", () => {
    expect(() => parseAmount("lots", "--revenue")).toThrow(/--revenue must be an amount/);
    expect(() => parseAmount("1.5x")).toThrow();
  });
});

describe("realistic parties", () => {
  it("names are realistic, unique across customers/vendors/employees and carry addresses", () => {
    for (const { id } of listIndustryTemplates()) {
      const plan = generate({ ...FIXED, template: id, customerCount: 300, employeeCount: 50 });
      const parties = [...plan.customers, ...plan.vendors, ...plan.employees, plan.payrollVendor];
      const names = parties.map((p) => p.name.toLowerCase());
      expect(new Set(names).size).toBe(names.length);
      for (const party of parties) {
        expect(party.name).not.toMatch(/EZTD|CLIENT-|VENDOR-/);
        expect(party.name).not.toContain(":");
        expect(party.name.length).toBeLessThanOrEqual(100);
        expect(party.address.line1).toMatch(/^\d+ /);
        expect(party.address.country).toBe("US");
        expect(party.email).toMatch(/^[a-z.]+@[a-z0-9.]+$/);
      }
      expect(plan.employees[0].givenName).toBeTruthy();
      expect(plan.employees[0].familyName).toBeTruthy();
    }
  });

  it("uses stable ids and transaction references by name", () => {
    const plan = generate(FIXED);
    expect(plan.customers[0].id).toBe("CUST-001");
    expect(plan.vendors[0].id).toBe("VEND-001");
    expect(plan.employees[0].id).toBe("EMP-001");
    expect(plan.payrollVendor.id).toBe("VEND-PAYROLL");
    const customerNames = new Set(plan.customers.map((c) => c.name));
    expect(plan.invoices.every((inv) => customerNames.has(inv.customerName))).toBe(true);
  });

  it("is locale-aware", () => {
    const plan = generate({ ...FIXED, country: "GB" });
    expect(plan.customers.every((c) => c.address.country === "GB")).toBe(true);
    expect(plan.employees[0].phone).toMatch(/^020 7946 0\d{3}$/);
  });

  it("is deterministic under a seed and varies across seeds", () => {
    const names = (seed) => generate({ ...FIXED, seed }).customers.map((c) => c.name);
    expect(names(7)).toEqual(names(7));
    expect(names(7)).not.toEqual(names(8));
  });
});

describe("generation is bounded", () => {
  const maxRatios = Object.fromEntries(
    Object.entries(RATIO_BOUNDS).map(([key, { max }]) => [key, max])
  );
  const entityCount = (plan) =>
    Object.entries(plan.metrics)
      .filter(([key]) => key.endsWith("Count"))
      .reduce((sum, [, value]) => sum + value, 0);

  it("documents a range for every ratio", () => {
    expect(Object.keys(RATIO_BOUNDS).sort()).toEqual(Object.keys(RATIOS).sort());
    for (const [key, { min, max }] of Object.entries(RATIO_BOUNDS)) {
      expect(RATIOS[key], key).toBeGreaterThanOrEqual(min);
      expect(RATIOS[key], key).toBeLessThanOrEqual(max);
    }
  });

  it("rejects out-of-range, non-numeric and unknown ratio overrides with a clear error", () => {
    expect(() => generate({ ratios: { transfersPerMonth: 1e9 } })).toThrow(
      /transfersPerMonth must be between 0 and 31 \(got 1000000000\)/
    );
    expect(() => resolveConfig("saas", { ratios: { invoicePaymentRate: 1.5 } })).toThrow(
      /invoicePaymentRate must be between 0 and 1/
    );
    expect(() => resolveConfig("saas", { ratios: { paymentDelayMaxDays: -1 } })).toThrow(
      /paymentDelayMaxDays must be between 0 and 365/
    );
    expect(() => validateRatioOverrides({ transfersPerMonth: "lots" })).toThrow(/got "lots"/);
    expect(() => validateRatioOverrides({ transfersPerMonth: Infinity })).toThrow(
      /must be a number/
    );
    expect(() => validateRatioOverrides({ transfersPerMonth: true })).toThrow(/must be a number/);
    expect(() => validateRatioOverrides({ nope: 1, transfersPerMonth: 99 })).toThrow(
      /Unknown ratio: nope/
    );
    expect(validateRatioOverrides({ transfersPerMonth: "3" })).toEqual({ transfersPerMonth: "3" });
    expect(validateRatioOverrides(undefined)).toBeUndefined();
  });

  it("clamps template ratios to the same bounds", () => {
    const config = resolveConfig({ id: "custom", ratios: { transfersPerMonth: 5000 } });
    expect(config.ratios.transfersPerMonth).toBe(RATIO_BOUNDS.transfersPerMonth.max);
  });

  it("every built-in template and preset resolves within the bounds", () => {
    for (const { id } of listIndustryTemplates()) {
      expect(() => resolveConfig(id)).not.toThrow();
    }
    for (const { id } of listScenarioPresets()) {
      expect(() => generate({ ...FIXED, preset: id })).not.toThrow();
    }
  });

  it("caps an explicit period at MAX_MONTHS calendar months", () => {
    expect(countPeriodMonths("2025-01-31", "2025-02-01")).toBe(2);
    expect(countPeriodMonths("2025-01-01", "2025-12-31")).toBe(12);
    expect(() => resolvePeriod({ startDate: "1900-01-01", endDate: "2100-12-31" })).toThrow(
      /spans 2412 months; the maximum is 120/
    );
    expect(() => generate({ startDate: "2010-01-01", endDate: "2020-01-01" })).toThrow(
      /spans 121 months/
    );
    expect(resolvePeriod({ startDate: "2015-01-01", endDate: "2024-12-31" })).toEqual({
      startDate: "2015-01-01",
      endDate: "2024-12-31"
    });
  });

  it("stays small even at the worst case the bounds allow", () => {
    // customerCount <= 300, employeeCount <= 50 (generator clamp), months x customers <= 5000,
    // months <= 120, every ratio at its maximum: about 17k-25k entities in well under a second.
    // Without the bounds a single override such as transfersPerMonth=1e5 would produce >1M transfers.
    const cases = [
      { customerCount: 300, employeeCount: 100, startDate: "2020-01-01", endDate: "2021-04-30" },
      { customerCount: 41, employeeCount: 100, startDate: "2015-01-01", endDate: "2024-12-31" }
    ];
    for (const request of cases) {
      const startedAt = Date.now();
      const plan = generate({ ...request, ratios: maxRatios, seed: 1 });
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(entityCount(plan)).toBeLessThan(30000);
      expect(plan.metrics.transferCount).toBeLessThanOrEqual(31 * plan.metrics.monthCount);
    }
    expect(() =>
      generate({ customerCount: 300, startDate: "2015-01-01", endDate: "2024-12-31" })
    ).toThrow(/too many invoices/);
  });
});

import { describe, it, expect } from "vitest";
import { normalizeRequest, buildSyntheticPlan } from "../src/generator.js";
import { resolveConfig } from "../src/ratios.js";

describe("normalizeRequest", () => {
  it("should normalize a valid request", () => {
    const result = normalizeRequest({
      startDate: "2024-01-01",
      endDate: "2024-12-31",
      totalRevenue: 500000,
      targetEbitda: 100000,
      customerCount: 10,
      clientConcentrationPercent: 40,
      employeeCount: 5,
      includeBenefits: true
    });

    expect(result.totalRevenue).toBe(500000);
    expect(result.customerCount).toBe(10);
    expect(result.tag).toBe("EZTD");
    expect(result.startDate).toBeInstanceOf(Date);
    expect(result.endDate).toBeInstanceOf(Date);
  });

  it("should throw on invalid date", () => {
    expect(() =>
      normalizeRequest({
        startDate: "not-a-date",
        endDate: "2024-12-31",
        totalRevenue: 100000,
        targetEbitda: 50000,
        customerCount: 5,
        clientConcentrationPercent: 30
      })
    ).toThrow("startDate is not a valid date");
  });

  it("should throw when endDate before startDate", () => {
    expect(() =>
      normalizeRequest({
        startDate: "2024-12-31",
        endDate: "2024-01-01",
        totalRevenue: 100000,
        targetEbitda: 50000,
        customerCount: 5,
        clientConcentrationPercent: 30
      })
    ).toThrow("endDate must be on or after startDate");
  });

  it("should include country in output when country is specified", () => {
    const result = normalizeRequest({
      startDate: "2024-01-01",
      endDate: "2024-12-31",
      totalRevenue: 500000,
      targetEbitda: 100000,
      customerCount: 10,
      clientConcentrationPercent: 40,
      employeeCount: 5,
      includeBenefits: true,
      country: "GB"
    });

    expect(result.country).toBe("GB");
  });

  it("should default country to US when not specified", () => {
    const result = normalizeRequest({
      startDate: "2024-01-01",
      endDate: "2024-12-31",
      totalRevenue: 500000,
      targetEbitda: 100000,
      customerCount: 10,
      clientConcentrationPercent: 40
    });

    expect(result.country).toBe("US");
  });

  it("should reject invalid country codes", () => {
    expect(() =>
      normalizeRequest({
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        totalRevenue: 500000,
        targetEbitda: 100000,
        customerCount: 10,
        clientConcentrationPercent: 40,
        country: "ZZ"
      })
    ).toThrow("country must be one of");
  });
});

describe("buildSyntheticPlan", () => {
  it("should generate a complete plan with default config", () => {
    const config = resolveConfig();
    const input = normalizeRequest({
      startDate: "2024-01-01",
      endDate: "2024-06-30",
      totalRevenue: 300000,
      targetEbitda: 60000,
      customerCount: 5,
      clientConcentrationPercent: 40,
      employeeCount: 3,
      includeBenefits: true
    });

    const plan = buildSyntheticPlan(input, config);

    expect(plan.tag).toBe("EZTD");
    expect(plan.customers).toHaveLength(5);
    expect(plan.invoices.length).toBeGreaterThan(0);
    expect(plan.bills.length).toBeGreaterThan(0);
    expect(plan.payments.length).toBeGreaterThan(0);
    expect(plan.employees).toHaveLength(3);
    expect(plan.payroll.length).toBeGreaterThan(0);
    expect(plan.metrics).toBeDefined();
    expect(plan.metrics.totalRevenueGenerated).toBeCloseTo(300000, -2);
  });

  it("should include country in plan when country is GB", () => {
    const config = resolveConfig({}, {}, "GB");
    const input = normalizeRequest({
      startDate: "2024-01-01",
      endDate: "2024-06-30",
      totalRevenue: 300000,
      targetEbitda: 60000,
      customerCount: 5,
      clientConcentrationPercent: 40,
      employeeCount: 3,
      includeBenefits: true,
      country: "GB"
    });

    const plan = buildSyntheticPlan(input, config);

    expect(plan.country).toBe("GB");
    expect(plan.customers).toHaveLength(5);
    expect(plan.invoices.length).toBeGreaterThan(0);
  });

  it("should generate a plan with custom tag", () => {
    const config = resolveConfig();
    const input = normalizeRequest({
      startDate: "2024-01-01",
      endDate: "2024-03-31",
      totalRevenue: 100000,
      targetEbitda: 20000,
      customerCount: 3,
      clientConcentrationPercent: 50,
      tag: "TESTRUN"
    });

    const plan = buildSyntheticPlan(input, config);
    expect(plan.tag).toBe("TESTRUN");
    expect(plan.invoices[0].docNumber).toMatch(/^TESTRUN-INV-/);
  });
});

describe("resolveConfig", () => {
  it("should return base config with no overrides", () => {
    const config = resolveConfig();
    expect(config.ratios.invoicedRevenueShare).toBe(0.92);
    expect(config.serviceItems).toHaveLength(5);
    expect(config.expenseCategories).toHaveLength(8);
  });

  it("should merge template ratio overrides", () => {
    const template = {
      ratios: { invoicedRevenueShare: 0.15, cashSalesShare: 0.85 }
    };
    const config = resolveConfig(template);
    expect(config.ratios.invoicedRevenueShare).toBe(0.15);
    expect(config.ratios.cashSalesShare).toBe(0.85);
    expect(config.ratios.payrollShare).toBe(0.55); // untouched
  });

  it("should allow user overrides to beat template", () => {
    const template = { ratios: { invoicedRevenueShare: 0.5 } };
    const user = { ratios: { invoicedRevenueShare: 0.7 } };
    const config = resolveConfig(template, user);
    expect(config.ratios.invoicedRevenueShare).toBe(0.7);
  });
});

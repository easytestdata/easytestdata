import { countPeriodMonths } from "@easytestdata/core";
import { describe, expect, it } from "vitest";
import { buildPlanFromScenario, normalizeScenarioConfig } from "../src/services/scenario-config.js";

const connectionId = "00000000-0000-4000-8000-000000000000";

describe("scenario presets", () => {
  it("uses preset values for fields the config does not set", () => {
    const config = normalizeScenarioConfig({ connectionId, presetId: "rapid-growth" }, "saas");
    expect(config.totalRevenue).toBe(2000000);
    expect(config.targetEbitda).toBe(120000);
    expect(config.customerCount).toBe(90);
    expect(config.employeeCount).toBe(30);
    expect(config.includeBenefits).toBe(true);
  });

  it("lets explicit config values override the preset", () => {
    const config = normalizeScenarioConfig(
      { connectionId, presetId: "rapid-growth", customerCount: 12 },
      "saas"
    );
    expect(config.customerCount).toBe(12);
    expect(config.topCustomerCount).toBeLessThanOrEqual(12);
    expect(config.employeeCount).toBe(30);
  });

  it("uses the preset's own period length when the config gives no dates", () => {
    const config = normalizeScenarioConfig({ connectionId, presetId: "quick-demo" }, "saas");
    expect(countPeriodMonths(config.startDate, config.endDate)).toBe(3);
    const plain = normalizeScenarioConfig({ connectionId }, "saas");
    expect(countPeriodMonths(plain.startDate, plain.endDate)).toBe(12);
  });

  it("lets explicit months or dates override the preset's period length", () => {
    const byMonths = normalizeScenarioConfig(
      { connectionId, presetId: "quick-demo", months: 6 },
      "saas"
    );
    expect(countPeriodMonths(byMonths.startDate, byMonths.endDate)).toBe(6);
    const byDates = normalizeScenarioConfig(
      { connectionId, presetId: "quick-demo", startDate: "2025-01-01", endDate: "2025-12-31" },
      "saas"
    );
    expect(byDates.startDate).toBe("2025-01-01");
    expect(byDates.endDate).toBe("2025-12-31");
    // A single date plus the preset: the preset's length applies from that date.
    const fromStart = normalizeScenarioConfig(
      { connectionId, presetId: "quick-demo", startDate: "2025-01-01" },
      "saas"
    );
    expect(fromStart.endDate).toBe("2025-03-31");
  });

  it("changes the generated plan", () => {
    const base = { connectionId, startDate: "2025-01-01", endDate: "2025-06-30" };
    const plain = buildPlanFromScenario(normalizeScenarioConfig(base, "saas")).plan;
    const crisis = buildPlanFromScenario(
      normalizeScenarioConfig({ ...base, presetId: "cash-crisis" }, "saas")
    ).plan;
    expect(crisis.metrics.totalRevenueRequested).toBe(650000);
    expect(crisis.metrics.totalRevenueRequested).not.toBe(plain.metrics.totalRevenueRequested);
  });
});

describe("seeded server plans", () => {
  it("builds the same plan for the same stored seed, and records it", () => {
    const config = normalizeScenarioConfig(
      { connectionId, presetId: "healthy-small", startDate: "2025-01-01", months: 3, seed: 42 },
      "saas"
    );
    expect(config.seed).toBe(42);
    const a = buildPlanFromScenario(config).plan;
    const b = buildPlanFromScenario(
      normalizeScenarioConfig(JSON.parse(JSON.stringify(config)))
    ).plan;
    expect(a.meta.seed).toBe(42);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("draws and records a seed when the config has none", () => {
    const config = normalizeScenarioConfig({ connectionId, startDate: "2025-01-01", months: 1 });
    const { plan } = buildPlanFromScenario(config);
    expect(Number.isInteger(plan.meta.seed)).toBe(true);
  });
});

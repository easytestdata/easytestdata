import { describe, expect, it } from "vitest";
import {
  applyScenarioPreset,
  generate,
  getIndustryTemplate,
  getScenarioPreset,
  industryTemplates,
  listIndustryTemplates,
  listScenarioPresets,
  resolveConfig,
  scenarioPresets
} from "../src/index.js";

describe("template and preset registries", () => {
  it("lists every registered industry template and scenario preset", () => {
    const templates = listIndustryTemplates();
    const presets = listScenarioPresets();

    expect(templates.map((item) => item.id)).toEqual(Object.keys(industryTemplates));
    expect(presets.map((item) => item.id)).toEqual(Object.keys(scenarioPresets));
    expect(templates.some((item) => item.id === "professional-services")).toBe(true);
    expect(presets.some((item) => item.id === "healthy-small")).toBe(true);
  });

  it("keeps healthy-small first (the CLI's default hint) and the quick demo last", () => {
    const ids = Object.keys(scenarioPresets);
    expect(ids[0]).toBe("healthy-small");
    expect(ids[ids.length - 1]).toBe("quick-demo");
  });

  it("describes every preset in outcome language, not jargon", () => {
    for (const preset of listScenarioPresets()) {
      expect(preset.name).not.toMatch(/preset|profile|ebitda/i);
      expect(preset.description).not.toMatch(/preset|profile|ebitda|SMB/i);
    }
  });

  it("quick-demo is a three-month company small enough to load in about a minute", () => {
    const preset = getScenarioPreset("quick-demo");
    expect(preset.months).toBe(3);
    const plan = generate({ preset: "quick-demo", months: preset.months, seed: 1 });
    const m = plan.metrics;
    const records = Object.entries(m)
      .filter(
        ([key]) => key.endsWith("Count") && key !== "monthCount" && key !== "topCustomerCount"
      )
      .reduce((sum, [, value]) => sum + value, 0);
    expect(m.monthCount).toBe(3);
    expect(m.customerCount).toBe(5);
    expect(records).toBeLessThan(150);
  });

  it("returns full template and preset objects by id", () => {
    const template = getIndustryTemplate("saas");
    const preset = getScenarioPreset("cash-crisis");

    expect(template).toBeTruthy();
    expect(template.name).toContain("SaaS");
    expect(Array.isArray(template.serviceItems)).toBe(true);
    expect(preset).toBeTruthy();
    expect(preset.request.totalRevenue).toBeGreaterThan(0);
  });

  it("includes complete professional-services template fields", () => {
    const template = getIndustryTemplate("professional-services");

    expect(template).toBeTruthy();
    expect(Array.isArray(template.serviceItems)).toBe(true);
    expect(template.serviceItems.length).toBeGreaterThan(0);
    expect(Array.isArray(template.expenseCategories)).toBe(true);
    expect(template.expenseCategories.length).toBeGreaterThan(0);
    expect(template.ratios.invoicedRevenueShare).toBe(0.92);
    expect(template.ratios.cashSalesShare).toBe(0.08);
  });
});

describe("resolveConfig and preset merge behavior", () => {
  it("merges template ratios with user overrides", () => {
    const template = getIndustryTemplate("saas");
    const resolved = resolveConfig(template, {
      ratios: {
        invoicePaymentRate: 0.5
      }
    });

    expect(resolved.ratios.invoicePaymentRate).toBe(0.5);
    expect(resolved.ratios.paymentDelayMinDays).toBe(10);
    expect(Array.isArray(resolved.serviceItems)).toBe(true);
  });

  it("keeps explicit request overrides when applying preset", () => {
    const applied = applyScenarioPreset(
      {
        totalRevenue: 123456,
        customerCount: 9,
        ratioOverrides: { invoicePaymentRate: 0.93 }
      },
      "cash-crisis"
    );

    expect(applied.request.totalRevenue).toBe(123456);
    expect(applied.request.customerCount).toBe(9);
    expect(applied.ratioOverrides.invoicePaymentRate).toBe(0.93);
    expect(applied.ratioOverrides.paymentDelayMinDays).toBe(35);
  });
});

describe("scenario length", () => {
  it("uses a preset's own months unless the caller sets the period", async () => {
    const { generate } = await import("../src/index.js");
    const quick = generate({ preset: "quick-demo", seed: 1, startDate: "2025-01-01" });
    expect(quick.meta.endDate).toBe("2025-03-31");
    const explicit = generate({
      preset: "quick-demo",
      seed: 1,
      startDate: "2025-01-01",
      months: 6
    });
    expect(explicit.meta.endDate).toBe("2025-06-30");
    const dated = generate({
      preset: "quick-demo",
      seed: 1,
      startDate: "2025-01-01",
      endDate: "2025-12-31"
    });
    expect(dated.meta.endDate).toBe("2025-12-31");
    const normal = generate({ preset: "healthy-small", seed: 1, startDate: "2025-01-01" });
    expect(normal.meta.endDate).toBe("2025-12-31");
  });
});

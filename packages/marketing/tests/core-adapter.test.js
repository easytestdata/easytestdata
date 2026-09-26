import { describe, expect, it } from "vitest";
import { cliCommand, generatePlan } from "../src/playground/core-adapter.js";

describe("playground CLI command", () => {
  it("passes --months whenever the CLI would otherwise pick a different length", () => {
    // Quick demo has its own 3-month length: a 12-month preview needs --months 12.
    expect(
      cliCommand("generate", { template: "saas", preset: "quick-demo", seed: 1, months: 12 })
    ).toContain("--months 12");
    expect(
      cliCommand("generate", { template: "saas", preset: "quick-demo", seed: 1, months: 3 })
    ).not.toContain("--months");
    expect(
      cliCommand("generate", { template: "saas", preset: "none", seed: 1, months: 12 })
    ).not.toContain("--months");
    expect(
      cliCommand("generate", { template: "saas", preset: "seasonal", seed: 1, months: 6 })
    ).toContain("--months 6");
  });

  it("describes the same period as the preview", () => {
    const today = new Date(Date.UTC(2026, 8, 24));
    const plan = generatePlan({
      template: "saas",
      preset: "quick-demo",
      seed: 1,
      months: 12,
      today
    });
    expect(plan.meta.startDate).toBe("2025-09-01");
    expect(plan.meta.endDate).toBe("2026-08-31");
  });
});

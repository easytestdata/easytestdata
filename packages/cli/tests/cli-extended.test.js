import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run, createProgram } from "../src/index.js";
import {
  CONFIG_FILE,
  getConnection,
  persistRefreshToken,
  requireConnection
} from "../src/config-loader.js";
import { parseRatioFlags } from "../src/ratio-parser.js";
import { planFromOptions, toFlagLanguage } from "../src/options.js";
import { formatPlanSummary } from "../src/summary.js";
import { redirectUriFor } from "../src/oauth.js";
import { countPeriodMonths, industryTemplates, scenarioPresets } from "@easytestdata/core";

const FIXED = { seed: 1, startDate: "2025-01-01", months: 12 };

describe("presets command", () => {
  it("outputs JSON array with preset objects including cash-crisis", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    run(["node", "easytestdata", "presets", "--json"]);
    const parsed = JSON.parse(logSpy.mock.calls.map((call) => call[0]).join("\n"));
    logSpy.mockRestore();

    expect(parsed.map((p) => p.id)).toEqual(Object.keys(scenarioPresets));
    expect(parsed.find((p) => p.id === "cash-crisis").name).toBeTruthy();
  });

  it("is also `scenarios`, the name the --scenario flag uses", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    run(["node", "easytestdata", "scenarios", "--json"]);
    const parsed = JSON.parse(logSpy.mock.calls.map((call) => call[0]).join("\n"));
    logSpy.mockRestore();

    expect(parsed.map((p) => p.id)).toEqual(Object.keys(scenarioPresets));
  });
});

describe("templates command", () => {
  it("outputs JSON array with templates including professional-services", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    run(["node", "easytestdata", "templates", "--json"]);
    const parsed = JSON.parse(logSpy.mock.calls.map((call) => call[0]).join("\n"));
    logSpy.mockRestore();

    expect(parsed.map((t) => t.id)).toEqual(Object.keys(industryTemplates));
    expect(parsed.some((t) => t.id === "professional-services")).toBe(true);
  });
});

describe("planFromOptions precedence", () => {
  it("applies the scenario when no flags are given", () => {
    const { plan } = planFromOptions({ ...FIXED, scenario: "rapid-growth" });
    expect(plan.customers).toHaveLength(90);
    expect(plan.metrics.totalRevenueRequested).toBe(2000000);
  });

  it("explicit flags beat the preset", () => {
    const { plan } = planFromOptions({ ...FIXED, scenario: "rapid-growth", customers: 12 });
    expect(plan.customers).toHaveLength(12);
    expect(plan.employees).toHaveLength(30);
  });

  it("preset beats config-file defaults, which beat built-in defaults", () => {
    const fileConfig = { defaults: { customers: 7, employees: 2, template: "retail" } };
    const withPreset = planFromOptions({ ...FIXED, scenario: "rapid-growth" }, fileConfig).plan;
    expect(withPreset.customers).toHaveLength(90);
    expect(withPreset.meta.industry).toBe("retail");
    const noPreset = planFromOptions(FIXED, fileConfig).plan;
    expect(noPreset.customers).toHaveLength(7);
    expect(noPreset.employees).toHaveLength(2);
  });

  it("a scenario's own length beats the config file's period, which may still anchor it", () => {
    const quick = planFromOptions(
      { scenario: "quick-demo", seed: 1 },
      { defaults: { months: 12 } }
    );
    expect(countPeriodMonths(quick.plan.meta.startDate, quick.plan.meta.endDate)).toBe(3);
    const anchored = planFromOptions(
      { scenario: "quick-demo", seed: 1 },
      { defaults: { startDate: "2025-01-01", endDate: "2025-12-31" } }
    );
    expect(anchored.plan.meta.startDate).toBe("2025-01-01");
    expect(anchored.plan.meta.endDate).toBe("2025-03-31");
    // Flags still beat the scenario, and a scenario without a length leaves the file's alone.
    const flagged = planFromOptions({ scenario: "quick-demo", seed: 1, months: 6 });
    expect(countPeriodMonths(flagged.plan.meta.startDate, flagged.plan.meta.endDate)).toBe(6);
    const seasonal = planFromOptions(
      { scenario: "seasonal", seed: 1 },
      { defaults: { months: 5 } }
    );
    expect(countPeriodMonths(seasonal.plan.meta.startDate, seasonal.plan.meta.endDate)).toBe(5);
  });

  it("merges the config file's period per field with the flags", () => {
    const months = (r) => countPeriodMonths(r.plan.meta.startDate, r.plan.meta.endDate);
    // --start-date keeps the file's length.
    const startFlag = planFromOptions(
      { startDate: "2025-01-01", seed: 1 },
      { defaults: { months: 5 } }
    );
    expect(startFlag.plan.meta.endDate).toBe("2025-05-31");
    // --months keeps the file's anchor.
    const monthsFlag = planFromOptions(
      { months: 2, seed: 1 },
      { defaults: { startDate: "2024-03-01", endDate: "2024-12-31" } }
    );
    expect(monthsFlag.plan.meta.startDate).toBe("2024-03-01");
    expect(months(monthsFlag)).toBe(2);
    // --end-date replaces the file's anchor and keeps its months.
    const endFlag = planFromOptions(
      { endDate: "2025-12-31", seed: 1 },
      { defaults: { startDate: "2020-01-01", months: 4 } }
    );
    expect(endFlag.plan.meta.startDate).toBe("2025-09-01");
    // Both file dates apply when no flag touches the period.
    const fileOnly = planFromOptions(
      { seed: 1 },
      { defaults: { startDate: "2024-01-01", endDate: "2024-06-30" } }
    );
    expect(months(fileOnly)).toBe(6);
  });

  it("every preset differs from the default", () => {
    const base = JSON.stringify(planFromOptions(FIXED).plan);
    for (const id of ["healthy-small", "cash-crisis", "seasonal", "new-company"]) {
      expect(JSON.stringify(planFromOptions({ ...FIXED, scenario: id }).plan)).not.toBe(base);
    }
  });

  it("reports whether the seed was given and always records one", () => {
    const given = planFromOptions(FIXED);
    expect(given.seedGiven).toBe(true);
    expect(given.plan.meta.seed).toBe(1);
    const fromFile = planFromOptions({ startDate: "2025-01-01" }, { defaults: { seed: 5 } });
    expect(fromFile.seedGiven).toBe(true);
    expect(fromFile.plan.meta.seed).toBe(5);
    const random = planFromOptions({ startDate: "2025-01-01" });
    expect(random.seedGiven).toBe(false);
    expect(Number.isInteger(random.plan.meta.seed)).toBe(true);
  });

  it("passes --ratio through", () => {
    const { plan } = planFromOptions({ ...FIXED, ratio: ["invoicePaymentRate=0"] });
    expect(plan.payments).toHaveLength(0);
  });

  it("throws with valid names for unknown template/preset", () => {
    expect(() => planFromOptions({ template: "bakery" })).toThrow(/Valid templates: .*saas/);
    expect(() => planFromOptions({ scenario: "boom" })).toThrow(
      /Unknown scenario "boom"\. Valid scenarios: .*cash-crisis/
    );
  });

  it("speaks in flag names", () => {
    expect(() => planFromOptions({ ...FIXED, customers: 2, topCustomers: 5 })).toThrow(
      "--top-customers cannot exceed --customers."
    );
    expect(toFlagLanguage("Pass at most two of startDate, endDate and months.")).toBe(
      "Pass at most two of --start-date, --end-date and --months."
    );
  });
});

describe("summary", () => {
  it("lists counts and period totals", () => {
    const { plan } = planFromOptions({ ...FIXED, revenue: 1500000, profit: -50000 });
    const text = formatPlanSummary(plan);
    expect(text).toContain("seed 1");
    expect(text).not.toContain("Re-run with");
    expect(text).toMatch(/Customers\s+15/);
    expect(text).toMatch(new RegExp(`Vendors\\s+${plan.metrics.vendorCount}\\b`));
    expect(text).toMatch(/Invoices\s+180/);
    expect(text).toMatch(/Total revenue\s+\$1,500,000\.00/);
    expect(text).toMatch(/Total expenses\s+\$1,550,000\.00/);
    expect(text).toMatch(/Target profit\s+-\$50,000\.00/);
  });

  it("prints the drawn seed and how to reproduce a seedless run", () => {
    const { plan, seedGiven } = planFromOptions({
      startDate: "2025-03-01",
      scenario: "quick-demo"
    });
    const text = formatPlanSummary(plan, { seedGiven });
    expect(text).toContain(`quick-demo scenario · seed ${plan.meta.seed}`);
    expect(text).toContain(
      `Re-run with --seed ${plan.meta.seed} --start-date 2025-03-01 to get the same data.`
    );
  });
});

describe("sandbox-only configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("never produces a base URL, even when QBO_BASE_URL is set", () => {
    vi.stubEnv("QBO_BASE_URL", "https://quickbooks.api.intuit.com");
    const conn = getConnection({
      connections: { default: { realmId: "1", refreshToken: "r", baseUrl: "https://x" } }
    });
    expect(conn).not.toHaveProperty("qboBaseUrl");
  });

  it("has no production option on auth", () => {
    const auth = createProgram().commands.find((c) => c.name() === "auth");
    expect(auth.options.map((o) => o.long)).not.toContain("--environment");
  });

  it("points users at auth when no connection exists", () => {
    vi.stubEnv("QBO_REFRESH_TOKEN", "");
    vi.stubEnv("QBO_REALM_ID", "");
    expect(() => requireConnection({})).toThrow(/Run `easytestdata auth` to connect/);
  });

  it("uses the documented redirect URI", () => {
    expect(redirectUriFor()).toBe("http://localhost:8085/callback");
  });
});

describe("config file permissions", () => {
  it.skipIf(process.platform === "win32")(
    "makes an existing, readable config file owner-only when tokens are written to it",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "eztd-cli-config-"));
      const file = join(dir, CONFIG_FILE);
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
      try {
        writeFileSync(file, "{}\n");
        chmodSync(file, 0o644);
        persistRefreshToken({}, "default", { refreshToken: "r", accessToken: "a" });
        expect(statSync(file).mode & 0o777).toBe(0o600);
      } finally {
        cwd.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});

describe("ratio-parser", () => {
  it("returns null for empty input", () => {
    expect(parseRatioFlags(null)).toBeNull();
    expect(parseRatioFlags([])).toBeNull();
  });

  it("parses key=value pairs", () => {
    expect(parseRatioFlags(["invoicePaymentRate=0.8", "transfersPerMonth=2"])).toEqual({
      invoicePaymentRate: 0.8,
      transfersPerMonth: 2
    });
    expect(parseRatioFlags(["invoicePaymentRate=0"])).toEqual({ invoicePaymentRate: 0 });
  });

  it("throws on bad input", () => {
    expect(() => parseRatioFlags(["bad-format"])).toThrow("Invalid --ratio format");
    expect(() => parseRatioFlags(["key=notanumber"])).toThrow("Invalid --ratio value");
  });
});

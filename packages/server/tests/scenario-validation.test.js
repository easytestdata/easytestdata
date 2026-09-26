import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REQUEST, generate } from "@easytestdata/core";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  enforceJobCreationLimits: vi.fn(),
  notifyJobQueued: vi.fn()
}));

vi.mock("../src/middleware/auth.js", () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: "user-1", teamId: "team-1", role: "owner" };
    next();
  }
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args) => mocks.query(...args)
}));

vi.mock("../src/services/limits.js", () => ({
  enforceJobCreationLimits: (...args) => mocks.enforceJobCreationLimits(...args),
  getDeployment: () => "cloud",
  getLimits: () => ({ loadsPerMonth: 10, entitiesPerJob: 5000 }),
  limitExceededError: (kind) => Object.assign(new Error(`${kind} limit`), { statusCode: 403 }),
  getMonthlyUsage: async () => ({})
}));

vi.mock("../src/workers/runner.js", () => ({
  notifyJobQueued: (...args) => mocks.notifyJobQueued(...args)
}));

import { jobRoutes } from "../src/routes/jobs.js";
import {
  countPlanEntities,
  estimateEntityCount,
  normalizeScenarioConfig
} from "../src/services/scenario-config.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", jobRoutes());
  app.use((err, _req, res, _next) => {
    res.status(err.status || err.statusCode || 500).json({ error: err.message });
  });
  return app;
}

describe("normalizeScenarioConfig", () => {
  it("uses core's defaults", () => {
    const config = normalizeScenarioConfig({}, "saas");
    expect(config.totalRevenue).toBe(DEFAULT_REQUEST.totalRevenue);
    expect(config.targetEbitda).toBe(DEFAULT_REQUEST.targetEbitda);
    expect(config.customerCount).toBe(DEFAULT_REQUEST.customerCount);
    expect(config.employeeCount).toBe(DEFAULT_REQUEST.employeeCount);
    expect(config.topCustomerCount).toBe(DEFAULT_REQUEST.topCustomerCount);
  });

  it("keeps the default margin when only revenue is set", () => {
    const config = normalizeScenarioConfig({ totalRevenue: 1000000 }, "saas");
    expect(config.targetEbitda).toBe(200000);
  });

  it("accepts months for the period", () => {
    const config = normalizeScenarioConfig({ startDate: "2025-01-01", months: 6 }, "saas");
    expect(config).toMatchObject({ startDate: "2025-01-01", endDate: "2025-06-30" });
    const trailing = normalizeScenarioConfig({ months: 3 }, "saas");
    const days = (Date.parse(trailing.endDate) - Date.parse(trailing.startDate)) / 86400000;
    expect(days).toBeGreaterThan(85);
    expect(days).toBeLessThan(93);
  });

  it.each([
    [{ templateId: "no-such-template" }, /Unknown template "no-such-template"/],
    [{ presetId: "no-such-preset" }, /Unknown preset "no-such-preset"/],
    [{ totalRevenue: 100000, targetEbitda: 200000 }, /targetEbitda cannot exceed totalRevenue/],
    [{ startDate: "2025-01-01", endDate: "2025-12-31", months: 3 }, /at most two/],
    [{ months: 0 }, /months must be/],
    [{ totalRevenue: "lots" }, /totalRevenue must be an amount/]
  ])("rejects %j with a validation error", (config, message) => {
    let error;
    try {
      normalizeScenarioConfig(config, "saas");
    } catch (err) {
      error = err;
    }
    // ZodErrors are answered with 400 and their first issue's message.
    expect(error?.name).toBe("ZodError");
    expect(error.issues[0].message).toMatch(message);
  });
});

describe("entity estimate", () => {
  it("counts the entities of the generated plan", () => {
    const config = normalizeScenarioConfig(
      { startDate: "2025-01-01", endDate: "2025-12-31" },
      "saas"
    );
    const estimate = estimateEntityCount(config);
    const plan = generate({ template: "saas", startDate: "2025-01-01", endDate: "2025-12-31" });
    const actual = countPlanEntities(plan.metrics);
    // Plans are randomized without a seed, so allow a small spread.
    expect(Math.abs(estimate - actual) / actual).toBeLessThan(0.1);
    // Far more than just the parties: every transaction type counts.
    expect(estimate).toBeGreaterThan(config.customerCount * 10);
  });
});

describe("job routes validate configs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [] });
  });

  it.each([
    [{ templateId: "nope", config: {} }, /Unknown template/],
    [{ templateId: "saas", config: { presetId: "nope" } }, /Unknown preset/],
    [
      { templateId: "saas", config: { totalRevenue: 100000, targetEbitda: 150000 } },
      /targetEbitda cannot exceed totalRevenue/
    ]
  ])("POST /jobs rejects %j with 400 and creates nothing", async (body, message) => {
    const res = await request(makeApp())
      .post("/api/jobs")
      .send({ type: "generate", ...body });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("POST /jobs/estimate rejects unknown templates and presets with 400", async () => {
    const app = makeApp();
    const template = await request(app)
      .post("/api/jobs/estimate")
      .send({ templateId: "nope", config: {} });
    expect(template.status).toBe(400);
    const preset = await request(app)
      .post("/api/jobs/estimate")
      .send({ templateId: "saas", config: { presetId: "nope" } });
    expect(preset.status).toBe(400);
    const missing = await request(app).post("/api/jobs/estimate").send({ config: {} });
    expect(missing.status).toBe(400);
  });

  it.each([
    [
      "an out-of-range ratio override",
      { ratioOverrides: { transfersPerMonth: 1e9 } },
      /transfersPerMonth must be between 0 and 31/
    ],
    ["an unknown ratio override", { ratioOverrides: { nope: 1 } }, /Unknown ratio: nope/],
    [
      "a period longer than 120 months",
      { startDate: "1900-01-01", endDate: "2100-12-31" },
      /spans 2412 months; the maximum is 120/
    ],
    // Core generates at most 50 employees (MAX_EMPLOYEES); more must be refused, never clamped.
    ["more employees than the generator makes", { employeeCount: 51 }, /<=50/],
    [
      "too many customer-months",
      { customerCount: 300, startDate: "2015-01-01", endDate: "2024-12-31" },
      /too many invoices/
    ]
  ])(
    "rejects %s with 400 on estimate and job creation without building a plan",
    async (_label, config, message) => {
      const app = makeApp();
      const estimate = await request(app)
        .post("/api/jobs/estimate")
        .send({ templateId: "saas", config });
      expect(estimate.status).toBe(400);
      expect(estimate.body.error).toMatch(message);
      const job = await request(app)
        .post("/api/jobs")
        .send({ type: "generate", templateId: "saas", config });
      expect(job.status).toBe(400);
      expect(job.body.error).toMatch(message);
      expect(mocks.query).not.toHaveBeenCalled();
      expect(() => normalizeScenarioConfig({ ...config }, "saas")).toThrow(message);
    }
  );

  it("accepts the generator's maximum employee count and builds exactly that many", async () => {
    const res = await request(makeApp())
      .post("/api/jobs/estimate")
      .send({ templateId: "saas", config: { employeeCount: 50 } });
    expect(res.status).toBe(200);
    expect(res.body.metrics.employeeCount).toBe(50);
  });

  it("POST /jobs/estimate returns the plan-based count and the per-job limit", async () => {
    const res = await request(makeApp())
      .post("/api/jobs/estimate")
      .send({ templateId: "saas", config: {} });
    expect(res.status).toBe(200);
    expect(res.body.estimatedEntities).toBeGreaterThan(300);
    expect(res.body.limit).toBe(5000);
    // The UI summarises the plan ("X customers, Y invoices...") from the metrics.
    expect(res.body.metrics.customerCount).toBeGreaterThan(0);
    expect(res.body.metrics.invoiceCount).toBeGreaterThan(0);
    // An estimate reads nothing and writes nothing.
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("POST /jobs/estimate uses the top-level templateId over one inside config", async () => {
    const res = await request(makeApp())
      .post("/api/jobs/estimate")
      .send({ templateId: "restaurant", config: { templateId: "no-such-template" } });
    // The stale copy inside config would be an unknown template (400); the top-level id wins.
    expect(res.status).toBe(200);
  });
});

describe("job creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [] });
  });

  it("checks plan limits with the plan-based estimate before inserting the job", async () => {
    const limitErr = Object.assign(new Error("Entity limit exceeded"), { status: 403 });
    mocks.enforceJobCreationLimits.mockRejectedValue(limitErr);

    const res = await request(makeApp())
      .post("/api/jobs")
      .send({ type: "generate", templateId: "saas", config: { customerCount: 300 } });

    expect(res.status).toBe(403);
    const [, estimate] = mocks.enforceJobCreationLimits.mock.calls[0];
    expect(estimate).toBeGreaterThan(1000);
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO jobs"))).toBe(false);
  });

  it("rejects a request without a templateId or with an unknown job type", async () => {
    const app = makeApp();
    const noTemplate = await request(app).post("/api/jobs").send({ type: "generate", config: {} });
    expect(noTemplate.status).toBe(400);
    const badType = await request(app)
      .post("/api/jobs")
      .send({ type: "rollback", templateId: "saas", config: {} });
    expect(badType.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

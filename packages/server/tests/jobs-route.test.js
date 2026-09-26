import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
// services/connection-guard.js: the connection row lock every QBO job insert takes first.
const CONNECTION_LOCK =
  "SELECT * FROM qbo_connections WHERE id = $1 AND team_id = $2 FOR NO KEY UPDATE";
const queryMock = vi.fn();
const notifyJobQueuedMock = vi.fn();
const enforceLimitsMock = vi.fn();

vi.mock("../src/middleware/auth.js", () => ({
  authenticate: (req, _res, next) => {
    req.user = {
      id: "user-1",
      teamId: "team-1",
      role: "owner"
    };
    next();
  }
}));

// Transactions run their statements through the same mock (as a client), in order.
vi.mock("../src/db/pool.js", async () => {
  const { fakeTransaction } = await import("./fake-transaction.js");
  const { transaction, rollback } = fakeTransaction(() => ({
    query: (...args) => queryMock(...args)
  }));
  return { query: (...args) => queryMock(...args), transaction, rollback };
});

vi.mock("../src/workers/runner.js", () => ({
  notifyJobQueued: (...args) => notifyJobQueuedMock(...args)
}));

vi.mock("../src/services/scenario-config.js", () => ({
  normalizeScenarioConfig: (raw) => ({
    connectionId: raw.connectionId,
    templateId: "saas",
    startDate: "2024-01-01",
    endDate: "2024-12-31",
    totalRevenue: 100000,
    targetEbitda: 20000,
    customerCount: 20,
    topCustomerCount: 3,
    clientConcentrationPercent: 40,
    employeeCount: 5,
    includeBenefits: false,
    tag: "EZTD",
    ratioOverrides: {}
  }),
  buildPlanFromScenario: () => ({
    plan: {
      metrics: {
        customerCount: 20,
        vendorCount: 5,
        employeeCount: 5
      }
    }
  }),
  countPlanEntities: () => 30,
  estimateEntityCount: () => 30
}));

vi.mock("../src/services/limits.js", () => ({
  enforceJobCreationLimits: (...args) => enforceLimitsMock(...args),
  getDeployment: () => "cloud",
  getLimits: () => ({ loadsPerMonth: 3, entitiesPerJob: 50 }),
  limitExceededError: (kind) => Object.assign(new Error(`${kind} limit`), { statusCode: 403 }),
  getMonthlyUsage: async () => ({ jobs: 2, entities: 40 })
}));

import { jobRoutes } from "../src/routes/jobs.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", jobRoutes());
  app.use((err, _req, res, _next) => {
    res.status(err.status || err.statusCode || 500).json({ error: err.message });
  });
  return app;
}

describe("POST /api/jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforceLimitsMock.mockResolvedValue({
      deployment: "cloud",
      limits: { loadsPerMonth: 3, entitiesPerJob: 50 }
    });

    queryMock.mockImplementation((sql) => {
      if (sql.includes(CONNECTION_LOCK)) {
        return Promise.resolve({
          rows: [{ id: CONNECTION_ID }]
        });
      }

      if (sql.includes("INSERT INTO jobs")) {
        return Promise.resolve({
          rows: [
            {
              id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
              team_id: "team-1",
              status: "pending",
              type: "load"
            }
          ]
        });
      }

      return Promise.resolve({ rows: [] });
    });
  });

  it("creates a pending job and wakes the job runner", async () => {
    const app = makeApp();

    const response = await request(app).post("/api/jobs").send({
      type: "load",
      connectionId: CONNECTION_ID,
      templateId: "saas",
      config: {}
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: "pending" });
    expect(notifyJobQueuedMock).toHaveBeenCalledTimes(1);
    expect(enforceLimitsMock).toHaveBeenCalledWith("team-1", 30);
  });

  it("rejects job creation when the connection is not owned by the team", async () => {
    queryMock.mockImplementation((sql) => {
      if (sql.includes(CONNECTION_LOCK)) {
        return Promise.resolve({ rows: [] });
      }

      return Promise.resolve({ rows: [] });
    });

    const response = await request(makeApp()).post("/api/jobs").send({
      type: "load",
      connectionId: CONNECTION_ID,
      templateId: "saas",
      config: {}
    });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Connection not found" });
    expect(queryMock).toHaveBeenCalledWith(CONNECTION_LOCK, [CONNECTION_ID, "team-1"]);
    expect(notifyJobQueuedMock).not.toHaveBeenCalled();
  });

  it("allows offline generate jobs even when the posted connection is gone", async () => {
    queryMock.mockImplementation((sql) => {
      // Connection was later deleted — an ownership lookup would return no rows.
      if (sql.includes(CONNECTION_LOCK)) {
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes("INSERT INTO jobs")) {
        return Promise.resolve({
          rows: [
            {
              id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
              team_id: "team-1",
              status: "pending",
              type: "generate"
            }
          ]
        });
      }

      return Promise.resolve({ rows: [] });
    });

    const response = await request(makeApp()).post("/api/jobs").send({
      type: "generate",
      connectionId: CONNECTION_ID,
      templateId: "saas",
      config: {}
    });

    expect(response.status).toBe(201);
    expect(notifyJobQueuedMock).toHaveBeenCalledTimes(1);
    // Offline job types must NOT trigger the QBO connection ownership check.
    expect(queryMock.mock.calls.some(([sql]) => sql.includes("qbo_connections"))).toBe(false);
    // ...and must persist NULL connection_id (col index 1) so the FK to
    // qbo_connections is not violated when the sandbox is gone.
    const insertCall = queryMock.mock.calls.find(([sql]) => sql.includes("INSERT INTO jobs"));
    expect(insertCall).toBeDefined();
    expect(insertCall[0]).toContain(
      "(team_id, connection_id, type, config, created_by, parent_job_id)"
    );
    expect(insertCall[1][1]).toBeNull();
    // A seed is fixed at creation and snapshotted, so the worker builds the estimated plan.
    const snapshot = JSON.parse(insertCall[1][3]);
    expect(Number.isInteger(snapshot.seed)).toBe(true);
    expect(snapshot.seed).toBeGreaterThan(0);
  });

  it("creates a pending rollback job and wakes the job runner", async () => {
    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1 AND team_id = $2")) {
        return Promise.resolve({
          rows: [
            {
              id: "parent-job-1",
              team_id: "team-1",
              connection_id: "connection-1",
              status: "failed_with_orphans",
              result: { ledger: { totalTracked: 2 } }
            }
          ]
        });
      }

      if (sql.includes(CONNECTION_LOCK)) return Promise.resolve({ rows: [{ id: "connection-1" }] });
      if (sql.includes("INSERT INTO jobs")) {
        return Promise.resolve({
          rows: [
            {
              id: "rollback-job-1",
              team_id: "team-1",
              status: "pending",
              type: "rollback"
            }
          ]
        });
      }

      return Promise.resolve({ rows: [] });
    });

    const response = await request(makeApp()).post("/api/jobs/parent-job-1/rollback").send({});

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ id: "rollback-job-1", status: "pending" });
    expect(notifyJobQueuedMock).toHaveBeenCalledTimes(1);
  });

  it("says a load was already rolled back instead of calling it not eligible", async () => {
    // A completed rollback moves its load from failed_with_orphans to failed.
    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1 AND team_id = $2")) {
        return Promise.resolve({
          rows: [{ id: "parent-job-1", team_id: "team-1", status: "failed", result: null }]
        });
      }
      if (sql.includes("type = 'rollback'"))
        return Promise.resolve({ rows: [{ status: "completed" }] });
      return Promise.resolve({ rows: [] });
    });

    const response = await request(makeApp()).post("/api/jobs/parent-job-1/rollback").send({});

    expect(response.status).toBe(409);
    expect(response.body.error).toBe("This load has already been rolled back.");
    const lookup = queryMock.mock.calls.find(([sql]) => sql.includes("type = 'rollback'"));
    expect(lookup[1]).toEqual(["parent-job-1", "team-1"]);
    expect(queryMock.mock.calls.some(([sql]) => sql.includes("INSERT INTO jobs"))).toBe(false);
  });

  it("explains which loads can be rolled back when this one never could", async () => {
    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1 AND team_id = $2")) {
        return Promise.resolve({
          rows: [{ id: "load-1", team_id: "team-1", status: "completed", result: null }]
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const response = await request(makeApp()).post("/api/jobs/load-1/rollback").send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe(
      "Only a load that stopped with records left in QuickBooks can be rolled back."
    );
    expect(queryMock.mock.calls.some(([sql]) => sql.includes("INSERT INTO jobs"))).toBe(false);
  });

  it("refuses a rollback while its sandbox is disconnected (the load stays rollback-eligible)", async () => {
    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1 AND team_id = $2")) {
        return Promise.resolve({
          rows: [
            {
              id: "parent-job-1",
              team_id: "team-1",
              connection_id: "connection-1",
              status: "failed_with_orphans",
              result: { ledger: { totalTracked: 2 } }
            }
          ]
        });
      }
      if (sql.includes("FROM qbo_connections")) {
        return Promise.resolve({ rows: [{ disconnected_at: "2026-09-01T00:00:00.000Z" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const response = await request(makeApp()).post("/api/jobs/parent-job-1/rollback").send({});

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/Reconnect/);
    expect(queryMock.mock.calls.some(([sql]) => sql.includes("INSERT INTO jobs"))).toBe(false);
  });

  it("refuses a QBO job on a disconnected sandbox", async () => {
    queryMock.mockImplementation((sql) =>
      Promise.resolve(
        sql.includes("FROM qbo_connections")
          ? { rows: [{ id: CONNECTION_ID, disconnected_at: "2026-09-01T00:00:00.000Z" }] }
          : { rows: [] }
      )
    );

    const response = await request(makeApp()).post("/api/jobs").send({
      type: "load",
      connectionId: CONNECTION_ID,
      templateId: "saas",
      config: {}
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/Reconnect/);
    expect(notifyJobQueuedMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/jobs/:id/cancel", () => {
  beforeEach(() => {
    queryMock.mockReset();
    notifyJobQueuedMock.mockReset();
  });

  it("cancels a pending job at once with the database update alone", async () => {
    queryMock.mockResolvedValue({
      rows: [{ id: "job-1", status: "cancelled", type: "load" }]
    });

    const response = await request(makeApp()).post("/api/jobs/job-1/cancel");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("cancelled");
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("WHEN status = 'pending' THEN 'cancelled' ELSE 'cancelling'");
    expect(sql).toContain("AND team_id = $2");
    expect(params).toEqual(["job-1", "team-1"]);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("asks the worker to stop a running job and keeps it active until it has", async () => {
    queryMock.mockResolvedValue({
      rows: [{ id: "job-2", status: "cancelling", type: "load" }]
    });

    const response = await request(makeApp()).post("/api/jobs/job-2/cancel");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("cancelling");
    // The worker still owns the job: only its status changed.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for a job that is not active", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const response = await request(makeApp()).post("/api/jobs/job-3/cancel");
    expect(response.status).toBe(404);
  });
});

describe("GET /api/jobs and /api/jobs/usage", () => {
  it("lists the team's jobs", async () => {
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "job-1",
          team_id: "team-1",
          type: "generate",
          status: "completed",
          created_at: new Date().toISOString()
        }
      ]
    });

    const res = await request(makeApp()).get("/api/jobs");

    expect(res.status).toBe(200);
    expect(res.body[0].id).toBe("job-1");
    // Scoped to the caller's team in SQL, bound to exactly that team id.
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/WHERE team_id = \$1\b/);
    expect(params).toEqual(["team-1"]);
    expect(res.body.every((job) => job.team_id === "team-1")).toBe(true);
  });

  it("returns the deployment, its limits and this month's usage", async () => {
    const res = await request(makeApp()).get("/api/jobs/usage");

    expect(res.status).toBe(200);
    expect(res.body.deployment).toBe("cloud");
    expect(res.body.limits.loadsPerMonth).toBe(3);
    expect(res.body.usage).toEqual({ jobs: 2, entities: 40 });
  });
});

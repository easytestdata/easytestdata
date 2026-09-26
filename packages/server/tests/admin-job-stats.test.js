import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const notifyJobQueuedMock = vi.fn();

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

const abortRunningJobMock = vi.fn();
vi.mock("../src/workers/index.js", () => ({
  abortRunningJob: (...args) => abortRunningJobMock(...args),
  JobForceFailedError: class JobForceFailedError extends Error {}
}));

import { jobRoutes } from "../src/routes/admin/jobs.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "admin-1", teamId: "team-1", isAdmin: true };
    next();
  });
  app.use("/admin/jobs", jobRoutes());
  app.use((err, _req, res, _next) => {
    res.status(err.status || err.statusCode || 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /admin/jobs/stats", () => {
  it("returns statusBreakdown, avgDuration, and failureRate", async () => {
    queryMock.mockImplementation((sql) => {
      if (sql.includes("GROUP BY status")) {
        return Promise.resolve({
          rows: [
            { status: "completed", count: 42 },
            { status: "failed", count: 3 }
          ]
        });
      }
      if (sql.includes("AVG")) {
        return Promise.resolve({
          rows: [
            { type: "generate", avg_seconds: 12 },
            { type: "load", avg_seconds: 45 }
          ]
        });
      }
      if (sql.includes("FILTER")) {
        return Promise.resolve({
          rows: [
            { date: "2026-02-01T00:00:00.000Z", failed: 1, total: 10 },
            { date: "2026-02-02T00:00:00.000Z", failed: 0, total: 8 }
          ]
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = makeApp();
    const res = await request(app).get("/admin/jobs/stats");

    expect(res.status).toBe(200);
    expect(res.body.statusBreakdown).toEqual([
      { status: "completed", count: 42 },
      { status: "failed", count: 3 }
    ]);
    expect(res.body.avgDuration).toEqual([
      { type: "generate", avg_seconds: 12 },
      { type: "load", avg_seconds: 45 }
    ]);
    expect(res.body.failureRate).toHaveLength(2);
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it("returns empty arrays when no data exists", async () => {
    queryMock.mockResolvedValue({ rows: [] });

    const app = makeApp();
    const res = await request(app).get("/admin/jobs/stats");

    expect(res.status).toBe(200);
    expect(res.body.statusBreakdown).toEqual([]);
    expect(res.body.avgDuration).toEqual([]);
    expect(res.body.failureRate).toEqual([]);
  });
});

describe("POST /admin/jobs/:id/retry", () => {
  function mockFailedJob(
    job,
    insert = () => Promise.resolve({ rows: [{ id: "new-job-1" }] }),
    count = () => 0
  ) {
    queryMock.mockImplementation((sql, params) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) return Promise.resolve({ rows: [job] });
      // The connection guard's row lock (services/connection-guard.js): the sandbox is connected.
      if (sql.includes("FROM qbo_connections WHERE id = $1 AND team_id = $2 FOR NO KEY UPDATE")) {
        return Promise.resolve({ rows: [{ id: params[0], team_id: params[1] }] });
      }
      if (sql.includes("COUNT(*)")) return Promise.resolve({ rows: [{ count: count(job) }] });
      if (sql.includes("INSERT INTO jobs")) return insert(sql, params);
      return Promise.resolve({ rows: [] });
    });
  }
  const insertCall = () => queryMock.mock.calls.find(([sql]) => sql.includes("INSERT INTO jobs"));

  it("creates a pending replacement job for the original team and creator, then wakes the runner", async () => {
    mockFailedJob({
      id: "failed-job-1",
      team_id: "team-9",
      connection_id: "connection-1",
      type: "load",
      config: { tag: "EZTD" },
      created_by: "user-7",
      parent_job_id: null
    });

    const res = await request(makeApp()).post("/admin/jobs/failed-job-1/retry");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "new-job-1" });
    const [sql, params] = insertCall();
    // Under the team's monthly load limit (insertLimitedJob), not a raw INSERT.
    const countCall = queryMock.mock.calls.find(([q]) => q.includes("COUNT(*)"));
    expect(countCall[1]).toEqual(["team-9"]);
    expect(sql).toContain("(team_id, connection_id, type, config, created_by, parent_job_id)");
    expect(params.slice(0, 6)).toEqual([
      "team-9",
      "connection-1",
      "load",
      JSON.stringify({ tag: "EZTD" }),
      "user-7",
      null
    ]);
    expect(notifyJobQueuedMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the parent job of a rollback, so the retried rollback finds its ledger", async () => {
    mockFailedJob({
      id: "failed-rollback-1",
      team_id: "team-9",
      connection_id: "connection-1",
      type: "rollback",
      config: {},
      created_by: "user-7",
      parent_job_id: "failed-load-1"
    });

    const res = await request(makeApp()).post("/admin/jobs/failed-rollback-1/retry");

    expect(res.status).toBe(200);
    const [, params] = insertCall();
    expect(params.slice(0, 6)).toEqual([
      "team-9",
      "connection-1",
      "rollback",
      "{}",
      "user-7",
      "failed-load-1"
    ]);
  });

  it("answers 409 (not 500) while the team already has a QBO job queued or running", async () => {
    mockFailedJob(
      { id: "failed-job-1", team_id: "team-9", connection_id: "c", type: "load", config: {} },
      () =>
        Promise.reject(
          Object.assign(new Error("duplicate key"), {
            code: "23505",
            constraint: "jobs_one_active_qbo_job_per_team"
          })
        )
    );

    const res = await request(makeApp()).post("/admin/jobs/failed-job-1/retry");

    expect(res.status).toBe(409);
    expect(notifyJobQueuedMock).not.toHaveBeenCalled();
  });

  it("answers 403 when retrying a load for a team at its monthly load limit", async () => {
    mockFailedJob(
      { id: "failed-job-1", team_id: "team-9", connection_id: "c", type: "load", config: {} },
      () => Promise.reject(new Error("should not insert at the limit")),
      () => 100
    );

    const res = await request(makeApp()).post("/admin/jobs/failed-job-1/retry");

    expect(res.status).toBe(403);
    expect(notifyJobQueuedMock).not.toHaveBeenCalled();
  });
});

describe("admin force-fail", () => {
  const updates = () => queryMock.mock.calls.filter(([sql]) => /UPDATE jobs/.test(sql));

  it("only force-fails running jobs, never one that is still cancelling", async () => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [] });
    const res = await request(makeApp()).post("/admin/jobs/job-1/force-fail");
    expect(res.status).toBe(404);
    for (const [sql] of queryMock.mock.calls) {
      expect(sql).toContain("status = 'running'");
      expect(sql).not.toContain("cancelling");
    }
    expect(abortRunningJobMock).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
  });

  it("stops a job running in this process and lets the worker fail it (202)", async () => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [{ id: "job-1" }], rowCount: 1 });
    abortRunningJobMock.mockReturnValue(true);

    const res = await request(makeApp()).post("/admin/jobs/job-1/force-fail");

    expect(res.status).toBe(202);
    expect(res.body.message).toMatch(/stopping/i);
    expect(abortRunningJobMock).toHaveBeenCalledWith("job-1", expect.any(Error));
    // The row stays running until the worker's own failure write (ledger and lock intact).
    expect(updates()).toHaveLength(0);
  });

  it("marks a stale running row (no run in this process) failed at once", async () => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [{ id: "job-1" }], rowCount: 1 });
    abortRunningJobMock.mockReturnValue(false);

    const res = await request(makeApp()).post("/admin/jobs/job-1/force-fail");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(updates()).toHaveLength(1);
    expect(updates()[0][0]).toContain("status = 'failed'");
    expect(updates()[0][0]).toContain("status = 'running'");
  });
});

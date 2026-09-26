import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  notifyJobQueued: vi.fn(),
  limits: { loadsPerMonth: 3, entitiesPerJob: 5000 }
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireTeamManager: (req, res, next) =>
    ["owner", "admin"].includes(req.user?.role)
      ? next()
      : res.status(403).json({ error: "Insufficient permissions" }),
  authenticate: (req, _res, next) => {
    req.user = { id: "user-1", teamId: "team-1", role: "owner" };
    next();
  },
  requireRole: () => (_req, _res, next) => next()
}));

// Transactions run their statements through the same mock (as a client), in order.
vi.mock("../src/db/pool.js", async () => {
  const { fakeTransaction } = await import("./fake-transaction.js");
  const { transaction, rollback } = fakeTransaction(() => ({
    query: (...args) => mocks.query(...args)
  }));
  return { query: (...args) => mocks.query(...args), transaction, rollback };
});

vi.mock("../src/workers/runner.js", () => ({
  notifyJobQueued: (...args) => mocks.notifyJobQueued(...args)
}));

vi.mock("../src/services/limits.js", async (importOriginal) => ({
  ...(await importOriginal()),
  enforceJobCreationLimits: async () => ({}),
  getDeployment: () => "cloud",
  getLimits: () => mocks.limits,
  getMonthlyUsage: async () => ({})
}));

import { jobRoutes } from "../src/routes/jobs.js";
import { connectionRoutes } from "../src/routes/connections.js";
import { ACTIVE_QBO_JOB_INDEX } from "../src/services/job-enqueue.js";
import { cleanupExpiredArtifacts } from "../src/services/job-artifacts.js";
import { config } from "../src/config.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", jobRoutes());
  app.use("/api/connections", connectionRoutes());
  app.use((err, _req, res, _next) => {
    res.status(err.status || err.statusCode || 500).json({ error: err.message, code: err.code });
  });
  return app;
}

const failedParent = {
  id: "parent-1",
  team_id: "team-1",
  connection_id: "conn-1",
  status: "failed_with_orphans",
  result: { ledger: { totalTracked: 2 } }
};

// services/connection-guard.js locks the team row, then the connection row, before any check.
const CONNECTION_LOCK = "FROM qbo_connections WHERE id = $1 AND team_id = $2 FOR NO KEY UPDATE";

function activeJobViolation() {
  const err = new Error("duplicate key value violates unique constraint");
  err.code = "23505";
  err.constraint = ACTIVE_QBO_JOB_INDEX;
  return err;
}

describe("QBO job fairness and limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limits = { loadsPerMonth: 3, entitiesPerJob: 5000 };
  });

  it("returns 409 when the team already has a QBO job queued or running (purge)", async () => {
    mocks.query.mockImplementation(async (sql) => {
      if (sql.includes(CONNECTION_LOCK)) return { rows: [{ id: "conn-1" }] };
      if (sql.includes("INSERT INTO jobs")) throw activeJobViolation();
      return { rows: [] };
    });
    const res = await request(makeApp()).post("/api/connections/conn-1/purge").send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already queued or running");
    expect(mocks.notifyJobQueued).not.toHaveBeenCalled();
  });

  it("never counts a purge against the monthly load limit", async () => {
    mocks.query.mockImplementation(async (sql) => {
      if (sql.includes(CONNECTION_LOCK)) return { rows: [{ id: "conn-1" }] };
      if (sql.includes("COUNT(*)")) throw new Error("a purge must not count loads");
      if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "job-1" }] };
      return { rows: [] };
    });
    const res = await request(makeApp()).post("/api/connections/conn-1/purge").send({});
    expect(res.status).toBe(201);
  });

  it("inserts under the team and connection row locks, in one transaction", async () => {
    // The checks and the insert run in a transaction that first locks the team row, so a
    // concurrent request waits for the commit (a load's monthly count is tested on PGlite).
    mocks.query.mockImplementation(async (sql) => {
      if (sql.includes(CONNECTION_LOCK)) return { rows: [{ id: "conn-1" }] };
      if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "job-1" }] };
      return { rows: [] };
    });

    const res = await request(makeApp()).post("/api/connections/conn-1/purge").send({});

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "job-1" });
    const calls = mocks.query.mock.calls;
    const lock = calls.find(([sql]) => sql.includes("FOR NO KEY UPDATE"));
    expect(lock[0]).toMatch(/FROM teams WHERE id = \$1 FOR NO KEY UPDATE/);
    expect(lock[1]).toEqual(["team-1"]);
    const order = calls.map(([sql]) => sql.trim().split(/\s+/)[0]);
    const begin = order.indexOf("BEGIN");
    expect(begin).toBe(0);
    expect(order).toEqual(["BEGIN", "SELECT", "SELECT", "INSERT", "COMMIT"]);
    expect(calls[2][0]).toContain(CONNECTION_LOCK);
  });

  it("refuses a second rollback of the same job", async () => {
    mocks.query.mockImplementation(async (sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) return { rows: [failedParent] };
      if (sql.includes(CONNECTION_LOCK)) return { rows: [{ id: "conn-1" }] };
      if (sql.includes("type = 'rollback'")) return { rows: [{ id: "rb-1", status: "pending" }] };
      if (sql.includes("INSERT INTO jobs")) throw new Error("should not insert");
      return { rows: [] };
    });
    const res = await request(makeApp()).post("/api/jobs/parent-1/rollback").send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("A rollback of this load is already running.");
  });

  it("says a cancelled rollback is still stopping instead of the generic busy message", async () => {
    mocks.query.mockImplementation(async (sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) return { rows: [failedParent] };
      if (sql.includes(CONNECTION_LOCK)) return { rows: [{ id: "conn-1" }] };
      if (sql.includes("type = 'rollback'")) {
        expect(sql).toContain("'cancelling'");
        return { rows: [{ status: "cancelling" }] };
      }
      if (sql.includes("INSERT INTO jobs")) throw new Error("should not insert");
      return { rows: [] };
    });
    const res = await request(makeApp()).post("/api/jobs/parent-1/rollback").send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(
      "A cancelled rollback of this load is still stopping. Try again once it has."
    );
  });

  it("says a load was already rolled back when its rollback completed", async () => {
    mocks.query.mockImplementation(async (sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) return { rows: [failedParent] };
      if (sql.includes(CONNECTION_LOCK)) return { rows: [{ id: "conn-1" }] };
      if (sql.includes("type = 'rollback'")) return { rows: [{ status: "completed" }] };
      if (sql.includes("INSERT INTO jobs")) throw new Error("should not insert");
      return { rows: [] };
    });
    const res = await request(makeApp()).post("/api/jobs/parent-1/rollback").send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("This load has already been rolled back.");
  });

  it("never counts a roll back against the monthly load limit", async () => {
    const counted = [];
    mocks.query.mockImplementation(async (sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) return { rows: [failedParent] };
      if (sql.includes(CONNECTION_LOCK)) return { rows: [{ id: "conn-1" }] };
      if (sql.includes("type = 'load' AND created_at")) counted.push(sql);
      if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "rollback-1" }] };
      return { rows: [] };
    });
    const res = await request(makeApp()).post("/api/jobs/parent-1/rollback").send({});
    expect(res.status).not.toBe(403);
    expect(counted).toEqual([]);
  });

  it("maps the active-job index violation to 409 for rollbacks too", async () => {
    mocks.query.mockImplementation(async (sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) return { rows: [failedParent] };
      if (sql.includes(CONNECTION_LOCK)) return { rows: [{ id: "conn-1" }] };
      if (sql.includes("INSERT INTO jobs")) throw activeJobViolation();
      return { rows: [] };
    });
    const res = await request(makeApp()).post("/api/jobs/parent-1/rollback").send({});
    expect(res.status).toBe(409);
  });

  it("defaults job concurrency to 6 QBO / 5 local jobs and job timeouts to finite values", () => {
    expect(config.jobs.qboConcurrency).toBe(6);
    expect(config.jobs.localConcurrency).toBe(5);
    expect(config.jobs.qboTimeoutMs).toBeGreaterThan(0);
    expect(config.jobs.localTimeoutMs).toBeGreaterThan(0);
    expect(config.jobs.artifactTtlDays).toBe(7);
  });
});

describe("export artifact cleanup", () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "eztd-artifacts-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("deletes artifacts older than the TTL and keeps recent ones", async () => {
    const now = Date.now();
    const old = path.join(dir, "old-job.json");
    const oldCsv = path.join(dir, "old-job-csv.zip");
    const fresh = path.join(dir, "new-job.json");
    const unrelated = path.join(dir, "notes.txt");
    for (const file of [old, oldCsv, fresh, unrelated]) await fs.writeFile(file, "{}");
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);
    await fs.utimes(old, eightDaysAgo, eightDaysAgo);
    await fs.utimes(oldCsv, eightDaysAgo, eightDaysAgo);
    await fs.utimes(unrelated, eightDaysAgo, eightDaysAgo);

    const result = await cleanupExpiredArtifacts({ ttlDays: 7, dir, now });

    expect(result).toEqual({ deleted: 2, kept: 1 });
    expect((await fs.readdir(dir)).sort()).toEqual(["new-job.json", "notes.txt"]);
  });

  it("is a no-op when the artifact directory does not exist yet", async () => {
    const result = await cleanupExpiredArtifacts({ ttlDays: 7, dir: path.join(dir, "missing") });
    expect(result).toEqual({ deleted: 0, kept: 0 });
  });
});

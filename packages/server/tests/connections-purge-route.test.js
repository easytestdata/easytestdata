import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbQueryMock = vi.fn();
const notifyJobQueuedMock = vi.fn();

vi.mock("../src/middleware/auth.js", () => ({
  requireTeamManager: (req, res, next) =>
    ["owner", "admin"].includes(req.user?.role)
      ? next()
      : res.status(403).json({ error: "Insufficient permissions" }),
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
    query: (...args) => dbQueryMock(...args)
  }));
  return { query: (...args) => dbQueryMock(...args), transaction, rollback };
});

vi.mock("../src/workers/runner.js", () => ({
  notifyJobQueued: (...args) => notifyJobQueuedMock(...args)
}));

import { connectionRoutes } from "../src/routes/connections.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/connections", connectionRoutes());
  app.use((err, _req, res, _next) => {
    res.status(err.status || err.statusCode || 500).json({ error: err.message });
  });
  return app;
}

describe("POST /api/connections/:id/purge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbQueryMock.mockImplementation((sql) => {
      if (sql.includes("FROM qbo_connections WHERE id = $1 AND team_id = $2 FOR NO KEY UPDATE")) {
        return Promise.resolve({ rows: [{ id: "connection-1" }] });
      }

      if (sql.includes("INSERT INTO jobs")) {
        return Promise.resolve({
          rows: [
            {
              id: "purge-job-1",
              team_id: "team-1",
              status: "pending",
              type: "purge"
            }
          ]
        });
      }

      return Promise.resolve({ rows: [] });
    });
  });

  it("creates a pending purge job and wakes the job runner", async () => {
    const response = await request(makeApp())
      .post("/api/connections/connection-1/purge")
      .send({ tag: "eztd", mode: "all" });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ id: "purge-job-1", status: "pending" });
    const insert = dbQueryMock.mock.calls.find(([sql]) => sql.includes("INSERT INTO jobs"));
    expect(insert[0]).toContain(
      "(team_id, connection_id, type, config, created_by, parent_job_id)"
    );
    expect(insert[1].slice(0, 3)).toEqual(["team-1", "connection-1", "purge"]);
    expect(JSON.parse(insert[1][3])).toMatchObject({ tag: "EZTD", purgeMode: "all" });
    expect(notifyJobQueuedMock).toHaveBeenCalledTimes(1);
  });
});

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CONN = "11111111-1111-4111-8111-111111111111";
const queryMock = vi.fn();
let mockRole = "owner";
vi.mock("../src/db/pool.js", () => ({ query: (...a) => queryMock(...a) }));
vi.mock("../src/middleware/auth.js", () => ({
  authenticate: (req, _res, next) => (
    (req.user = { id: "u1", teamId: "t1", role: mockRole }),
    next()
  )
}));
const notifyJobQueuedMock = vi.fn();
vi.mock("../src/workers/runner.js", () => ({ notifyJobQueued: () => notifyJobQueuedMock() }));
vi.mock("../src/services/job-enqueue.js", async (orig) => ({
  ...(await orig()),
  // The job row the route asks for (the insert itself is tested in connection-guard-pglite).
  insertLimitedJob: vi.fn(async (job) => (await queryMock("INSERT INTO jobs", job)).rows[0])
}));

const { jobRoutes } = await import("../src/routes/jobs.js");
const app = express().use(express.json()).use("/jobs", jobRoutes());

describe("POST /jobs with an inline config", () => {
  beforeEach(() => {
    mockRole = "owner";
    queryMock.mockReset();
    notifyJobQueuedMock.mockReset();
    queryMock.mockImplementation(async (sql) => {
      if (sql.includes("FROM qbo_connections")) return { rows: [{ id: CONN }] };
      if (sql.includes("INSERT INTO jobs"))
        return { rows: [{ id: "j1", type: "load", status: "pending" }] };
      return { rows: [], rowCount: 0 };
    });
  });

  it("creates a load job with the top-level connectionId and never reads scenarios", async () => {
    const res = await request(app)
      .post("/jobs")
      .send({
        type: "load",
        connectionId: CONN,
        templateId: "saas",
        config: { presetId: "quick-demo" }
      });
    expect(res.status).toBe(201);
    expect(queryMock.mock.calls.some(([sql]) => sql.includes("scenarios"))).toBe(false);
    const [, job] = queryMock.mock.calls.find(([q]) => q.includes("INSERT INTO jobs"));
    expect(job).toMatchObject({ teamId: "t1", connectionId: CONN, type: "load", createdBy: "u1" });
    expect(job.config).toMatchObject({ templateId: "saas", connectionId: CONN });
    expect(Number.isInteger(job.config.seed)).toBe(true);
    // The row is the queue: the runner is woken to start it now.
    expect(notifyJobQueuedMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an out-of-bounds config with 400", async () => {
    const res = await request(app)
      .post("/jobs")
      .send({ type: "generate", templateId: "saas", config: { customerCount: 100000 } });
    expect(res.status).toBe(400);
    // Rejected by the config bounds (customerCount <= 300), not by the request shape.
    expect(res.body.error).toMatch(/<=300/);
    expect(queryMock.mock.calls.some(([sql]) => sql.includes("INSERT INTO jobs"))).toBe(false);
  });

  // A load that first purges ALL sandbox data is as destructive as a purge-all: owner/admin only.
  const purgeAllLoad = {
    type: "load",
    connectionId: CONN,
    templateId: "saas",
    config: { presetId: "quick-demo", purgeMode: "all" }
  };
  const inserted = () => queryMock.mock.calls.some(([sql]) => sql.includes("INSERT INTO jobs"));

  it("refuses a purge-all load from a member (403) and creates no job", async () => {
    mockRole = "member";
    const res = await request(app).post("/jobs").send(purgeAllLoad);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Only a team owner or admin can erase all data/);
    expect(inserted()).toBe(false);
    expect(notifyJobQueuedMock).not.toHaveBeenCalled();
  });

  it("lets a member load with generated-data purge (only purge-all is gated)", async () => {
    mockRole = "member";
    const res = await request(app)
      .post("/jobs")
      .send({ ...purgeAllLoad, config: { presetId: "quick-demo", purgeMode: "generated" } });
    expect(res.status).toBe(201);
  });

  it.each(["owner", "admin"])("lets an %s start a purge-all load", async (role) => {
    mockRole = role;
    const res = await request(app).post("/jobs").send(purgeAllLoad);
    expect(res.status).toBe(201);
    const [, job] = queryMock.mock.calls.find(([q]) => q.includes("INSERT INTO jobs"));
    expect(job.config.purgeMode).toBe("all");
  });
});

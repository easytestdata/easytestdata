import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// GET /jobs and GET /jobs/:id flag a load whose rollback completed (rolled_back), on the real
// schema (embedded PGlite), so the web app can show it as rolled back instead of failed.
const dir = mkdtempSync(join(tmpdir(), "eztd-jobs-rolled-back-pglite-"));
vi.stubEnv("DEPLOYMENT", "local");
vi.stubEnv("EASYTESTDATA_DATA_DIR", dir);
vi.stubEnv("TOKEN_ENCRYPTION_KEY", "ef".repeat(32));
vi.stubEnv("JWT_SECRET", "x".repeat(40));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));
const who = vi.hoisted(() => ({ user: null }));
vi.mock("../src/middleware/auth.js", () => ({
  authenticate: (req, _res, next) => {
    req.user = who.user;
    next();
  }
}));

const db = await import("../src/db/pool.js");
const { runMigrations } = await import("../src/db/migrate.js");
const { jobRoutes } = await import("../src/routes/jobs.js");

const app = express().use(express.json()).use("/api/v1/jobs", jobRoutes());

let teamId;

async function insertJob(type, status, parentJobId = null) {
  const { rows } = await db.query(
    `INSERT INTO jobs (team_id, type, status, config, parent_job_id)
     VALUES ($1, $2, $3, '{}', $4) RETURNING id`,
    [teamId, type, status, parentJobId]
  );
  return rows[0].id;
}

describe("rolled_back on the jobs API (PGlite)", () => {
  beforeAll(async () => {
    await runMigrations({ closePool: false });
    teamId = (await db.query("INSERT INTO teams (name) VALUES ('t') RETURNING id")).rows[0].id;
    const userId = (
      await db.query("INSERT INTO users (email) VALUES ('u@example.com') RETURNING id")
    ).rows[0].id;
    who.user = { id: userId, teamId, role: "owner" };
    // Migrating a fresh PGlite database is slow when the whole suite runs at once.
  }, 60_000);

  afterAll(async () => {
    await db.closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is true only for a load with a completed rollback", async () => {
    const rolledBack = await insertJob("load", "failed");
    await insertJob("rollback", "completed", rolledBack);
    const retrying = await insertJob("load", "failed_with_orphans");
    await insertJob("rollback", "failed", retrying);
    await insertJob("rollback", "running", retrying);
    const plainFailure = await insertJob("load", "failed");

    const list = await request(app).get("/api/v1/jobs");
    expect(list.status).toBe(200);
    const flag = Object.fromEntries(list.body.map((job) => [job.id, job.rolled_back]));
    expect(flag[rolledBack]).toBe(true);
    expect(flag[retrying]).toBe(false);
    expect(flag[plainFailure]).toBe(false);

    const detail = await request(app).get(`/api/v1/jobs/${rolledBack}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: rolledBack, status: "failed", rolled_back: true });
    expect((await request(app).get(`/api/v1/jobs/${retrying}`)).body.rolled_back).toBe(false);
  });

  // Purges store failureCount; loads only keep their failures list. The list derives the count so
  // the web app can show "Completed with errors" for either.
  it("reports a failure count for a load that kept only its failures list", async () => {
    const insertWithResult = async (type, result) =>
      (
        await db.query(
          `INSERT INTO jobs (team_id, type, status, config, result)
           VALUES ($1, $2, 'completed', '{}', $3) RETURNING id`,
          [teamId, type, JSON.stringify(result)]
        )
      ).rows[0].id;
    const load = await insertWithResult("load", { failures: [{ entity: "Customer" }, {}] });
    const purge = await insertWithResult("purge", { failureCount: 1, failures: [{}] });
    const clean = await insertWithResult("load", { counts: {} });

    const list = await request(app).get("/api/v1/jobs");
    const count = Object.fromEntries(
      list.body.map((job) => [job.id, job.result_summary?.failureCount ?? null])
    );
    expect(count[load]).toBe(2);
    expect(count[purge]).toBe(1);
    expect(count[clean]).toBeNull();
  });

  it("does not count another team's rollback", async () => {
    const load = await insertJob("load", "failed");
    const otherTeam = (await db.query("INSERT INTO teams (name) VALUES ('o') RETURNING id")).rows[0]
      .id;
    await db.query(
      `INSERT INTO jobs (team_id, type, status, config, parent_job_id)
       VALUES ($1, 'rollback', 'completed', '{}', $2)`,
      [otherTeam, load]
    );

    expect((await request(app).get(`/api/v1/jobs/${load}`)).body.rolled_back).toBe(false);
  });
});

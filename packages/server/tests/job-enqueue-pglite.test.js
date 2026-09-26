import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// insertLimitedJob's SQL against the real schema on an embedded PGlite database: the monthly
// load limit (forced to 2 here; local mode itself is unlimited) counted under the team row lock, and
// the one-active-QBO-job index mapped to 409.
const dir = mkdtempSync(join(tmpdir(), "eztd-job-enqueue-pglite-"));
vi.stubEnv("DEPLOYMENT", "local");
vi.stubEnv("EASYTESTDATA_DATA_DIR", dir);

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));
vi.mock("../src/services/limits.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getLimits: () => ({ loadsPerMonth: 2 })
}));

const db = await import("../src/db/pool.js");
const { runMigrations } = await import("../src/db/migrate.js");
const { insertLimitedJob } = await import("../src/services/job-enqueue.js");

let teamId;
let otherTeamId;

const job = (team, type = "generate") => ({ teamId: team, type });

describe("insertLimitedJob on PGlite", () => {
  beforeAll(async () => {
    await runMigrations({ closePool: false });
    teamId = (await db.query("INSERT INTO teams (name) VALUES ('t') RETURNING id")).rows[0].id;
    otherTeamId = (await db.query("INSERT INTO teams (name) VALUES ('o') RETURNING id")).rows[0].id;
  }, 60_000);
  afterAll(async () => {
    await db.closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await db.query("DELETE FROM jobs");
  });

  // One load may be active per team (the QBO fairness index), so each is finished before the next.
  async function finishedLoad(team) {
    const inserted = await insertLimitedJob(job(team, "load"));
    await db.query("UPDATE jobs SET status = 'completed' WHERE id = $1", [inserted.id]);
    return inserted;
  }

  it("inserts loads up to the monthly limit, then refuses (403), counting only this team's month", async () => {
    await db.query(
      "INSERT INTO jobs (team_id, type, status, created_at) VALUES ($1, 'load', 'completed', NOW() - INTERVAL '40 days')",
      [teamId]
    );
    await finishedLoad(otherTeamId);
    await finishedLoad(otherTeamId);

    const first = await finishedLoad(teamId);
    expect(first).toMatchObject({ team_id: teamId, type: "load", status: "pending" });
    await finishedLoad(teamId);
    await expect(insertLimitedJob(job(teamId, "load"))).rejects.toMatchObject({
      statusCode: 403,
      code: "LIMIT_EXCEEDED"
    });
    const { rows } = await db.query(
      "SELECT COUNT(*)::int AS n FROM jobs WHERE team_id = $1 AND type = 'load' AND created_at >= date_trunc('month', NOW())",
      [teamId]
    );
    expect(rows[0].n).toBe(2);
  });

  it("never counts downloads, removals or roll backs against the load limit", async () => {
    await finishedLoad(teamId);
    await finishedLoad(teamId);
    // At the load limit, other job types still go through.
    for (let i = 0; i < 3; i += 1) await insertLimitedJob(job(teamId, "generate"));
    const purge = await insertLimitedJob(job(teamId, "purge"));
    await db.query("UPDATE jobs SET status = 'completed' WHERE id = $1", [purge.id]);
    await insertLimitedJob(job(teamId, "rollback"));
    await expect(insertLimitedJob(job(teamId, "load"))).rejects.toMatchObject({ statusCode: 403 });
  });

  it("answers 409 for a second active QBO job and rolls the transaction back", async () => {
    await insertLimitedJob(job(teamId, "purge"));
    await expect(insertLimitedJob(job(teamId, "purge"))).rejects.toMatchObject({ statusCode: 409 });
    // The database is usable afterwards (the failed transaction did not leak).
    expect((await db.query("SELECT COUNT(*)::int AS n FROM jobs")).rows[0].n).toBe(1);
  });
});

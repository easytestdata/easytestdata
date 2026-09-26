import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The job runner's SQL against the real schema on an embedded PGlite database: the one active
// QBO job per team index, the pending-job query (types array, in-flight exclusion), the atomic
// claim, and restart recovery.
const dir = mkdtempSync(join(tmpdir(), "eztd-runner-pglite-"));
vi.stubEnv("DEPLOYMENT", "local");
vi.stubEnv("EASYTESTDATA_DATA_DIR", dir);

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

const db = await import("../src/db/pool.js");
const { runMigrations } = await import("../src/db/migrate.js");
const { recoverInterruptedJobs, startJobRunner } = await import("../src/workers/runner.js");
const { laterLoadMayUseMasterData } = await import("../src/workers/index.js");

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const CLAIM =
  "UPDATE jobs SET status = 'running', started_at = NOW() WHERE id = $1 AND status = 'pending'";

async function createTeam(name) {
  const team = (await db.query("INSERT INTO teams (name) VALUES ($1) RETURNING id", [name]))
    .rows[0];
  const connection = (
    await db.query(
      `INSERT INTO qbo_connections (team_id, realm_id, access_token_enc, refresh_token_enc, token_iv)
       VALUES ($1, $2, 'a', 'r', 'iv') RETURNING id`,
      [team.id, `realm-${name}`]
    )
  ).rows[0];
  return { teamId: team.id, connectionId: connection.id };
}

async function insertLoad({ teamId, connectionId }) {
  const { rows } = await db.query(
    "INSERT INTO jobs (team_id, connection_id, type) VALUES ($1, $2, 'load') RETURNING id",
    [teamId, connectionId]
  );
  return rows[0].id;
}

async function statusOf(id) {
  return (await db.query("SELECT status, error FROM jobs WHERE id = $1", [id])).rows[0];
}

describe("job runner on PGlite", () => {
  beforeAll(async () => runMigrations({ closePool: false }), 60_000);
  afterAll(async () => {
    await db.closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs two QBO jobs at a time, starts the third when one finishes, one active job per team", async () => {
    const teams = [await createTeam("a"), await createTeam("b"), await createTeam("c")];
    const ids = [];
    for (const team of teams) {
      ids.push(await insertLoad(team));
      await tick(5); // distinct created_at, so the start order is defined
    }
    const second = await insertLoad(teams[0]).catch((err) => err);
    expect(second.code).toBe("23505");
    expect(second.message).toMatch(/jobs_one_active_qbo_job_per_team/);

    const started = [];
    const release = {};
    const process = async ({ jobId }) => {
      const claimed = await db.query(CLAIM, [jobId]);
      if (!claimed.rowCount) return;
      started.push(jobId);
      await new Promise((resolve) => (release[jobId] = resolve));
      await db.query("UPDATE jobs SET status = 'completed', completed_at = NOW() WHERE id = $1", [
        jobId
      ]);
    };
    const runner = await startJobRunner({ qboConcurrency: 2, pollMs: 10, process });
    try {
      await tick();
      expect(started).toEqual(ids.slice(0, 2));
      expect((await statusOf(ids[2])).status).toBe("pending");
      release[ids[0]]();
      await tick();
      expect(started).toEqual(ids);
      release[ids[1]]();
      release[ids[2]]();
      await tick();
      for (const id of ids) expect((await statusOf(id)).status).toBe("completed");
    } finally {
      for (const resolve of Object.values(release)) resolve();
      await runner.stop();
    }
  });

  it("never dispatches a job twice while it is in flight but not yet claimed", async () => {
    const id = await insertLoad(await createTeam("slow-claim"));
    const calls = [];
    let release;
    const gate = new Promise((r) => (release = r));
    // The job stays pending until the gate opens; polls meanwhile must exclude it by id.
    const process = async ({ jobId }) => {
      calls.push(jobId);
      await gate;
      await db.query(CLAIM, [jobId]);
      await db.query("UPDATE jobs SET status = 'completed' WHERE id = $1", [jobId]);
    };
    const runner = await startJobRunner({ qboConcurrency: 2, pollMs: 5, process });
    try {
      await tick(100);
      expect(calls).toEqual([id]);
      expect((await statusOf(id)).status).toBe("pending");
    } finally {
      release();
      await runner.stop();
    }
    expect((await statusOf(id)).status).toBe("completed");
  });

  it("lets exactly one of two concurrent claims of a pending job win", async () => {
    const id = await insertLoad(await createTeam("race"));
    const results = await Promise.all([db.query(CLAIM, [id]), db.query(CLAIM, [id])]);
    expect(results.map((r) => r.rowCount).sort()).toEqual([0, 1]);
    await db.query("UPDATE jobs SET status = 'completed' WHERE id = $1", [id]);
  });

  it("finds a later load into the same sandbox (any team's connection) that may use a rolled-back load's master data", async () => {
    const team = await createTeam("later");
    const other = await createTeam("later-other");
    const insert = async (connectionId, teamId, status) =>
      (
        await db.query(
          "INSERT INTO jobs (team_id, connection_id, type, status) VALUES ($1, $2, 'load', $3) RETURNING id",
          [teamId, connectionId, status]
        )
      ).rows[0].id;
    const parent = await insert(team.connectionId, team.teamId, "failed_with_orphans");
    const parentJob = { id: parent, team_id: team.teamId, connection_id: team.connectionId };
    await tick(5);
    // Loads that never touched QBO, or on another sandbox, do not count.
    await insert(team.connectionId, team.teamId, "cancelled");
    await insert(other.connectionId, other.teamId, "completed");
    expect(await laterLoadMayUseMasterData(parentJob)).toBe(false);

    // Another team's connection to the same sandbox (realm) does count.
    const sameRealm = (
      await db.query(
        `INSERT INTO qbo_connections (team_id, realm_id, access_token_enc, refresh_token_enc, token_iv)
         VALUES ($1, 'realm-later', 'a', 'r', 'iv') RETURNING id`,
        [other.teamId]
      )
    ).rows[0].id;
    const otherTeamLoad = await insert(sameRealm, other.teamId, "completed");
    expect(await laterLoadMayUseMasterData(parentJob)).toBe(true);
    await db.query("DELETE FROM jobs WHERE id = $1", [otherTeamLoad]);

    for (const status of ["completed", "failed", "failed_with_orphans", "running"]) {
      const later = await insert(team.connectionId, team.teamId, status);
      expect(await laterLoadMayUseMasterData(parentJob), status).toBe(true);
      await db.query("DELETE FROM jobs WHERE id = $1", [later]);
    }
    // An earlier load does not count either.
    await db.query("UPDATE jobs SET created_at = NOW() + INTERVAL '1 hour' WHERE id = $1", [
      parent
    ]);
    await insert(team.connectionId, team.teamId, "completed");
    expect(await laterLoadMayUseMasterData(parentJob)).toBe(false);
    await db.query("DELETE FROM jobs WHERE team_id IN ($1, $2)", [team.teamId, other.teamId]);
  });

  it("fails a job a previous process left running, with the Remove test data hint", async () => {
    const id = await insertLoad(await createTeam("restart"));
    await db.query("UPDATE jobs SET status = 'running' WHERE id = $1", [id]);
    expect(await recoverInterruptedJobs()).toBe(1);
    const job = await statusOf(id);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/use "Remove test data" to delete them/);
  });

  it("cancels a job a previous process left cancelling, with the Remove test data hint", async () => {
    // Its ledger lived only in memory, so the load can no longer be rolled back.
    const id = await insertLoad(await createTeam("restart-cancelling"));
    await db.query("UPDATE jobs SET status = 'cancelling' WHERE id = $1", [id]);
    expect(await recoverInterruptedJobs()).toBe(1);
    const job = await statusOf(id);
    expect(job.status).toBe("cancelled");
    expect(job.error).toBe(
      'Cancelled while the server restarted. Records it created may remain; use "Remove test data" ' +
        "to delete them."
    );
  });
});

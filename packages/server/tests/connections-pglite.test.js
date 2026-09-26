import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The connection routes' SQL against the real schema on an embedded PGlite database: the
// per-connection prior-load flag, the guarded disconnect (history kept), and the connection limit taken under the
// team row lock (limit forced to 2 here; local mode itself is unlimited).
const dir = mkdtempSync(join(tmpdir(), "eztd-connections-pglite-"));
vi.stubEnv("DEPLOYMENT", "local");
vi.stubEnv("EASYTESTDATA_DATA_DIR", dir);
vi.stubEnv("QBO_CLIENT_ID", "client-123");
vi.stubEnv("QBO_CLIENT_SECRET", "secret-123");
vi.stubEnv("TOKEN_ENCRYPTION_KEY", "ef".repeat(32));
vi.stubEnv("JWT_SECRET", "x".repeat(40));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));
vi.mock("../src/workers/runner.js", () => ({ notifyJobQueued: vi.fn() }));
vi.mock("../src/services/limits.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getLimits: () => ({ connections: 2 })
}));
const who = vi.hoisted(() => ({ user: null }));
vi.mock("../src/middleware/auth.js", () => ({
  authenticate: (req, _res, next) => {
    req.user = who.user;
    next();
  },
  requireTeamManager: (_req, _res, next) => next()
}));

const db = await import("../src/db/pool.js");
const { runMigrations } = await import("../src/db/migrate.js");
const { connectionRoutes } = await import("../src/routes/connections.js");
const { connectionRoutes: adminConnectionRoutes } =
  await import("../src/routes/admin/connections.js");
const { dashboardRoutes } = await import("../src/routes/admin/dashboard.js");
const { errorHandler } = await import("../src/middleware/error-handler.js");

/** The `name=value` part of a Set-Cookie header (tests/utils.js imports the config too early). */
function cookiePair(res, name) {
  const header = (res.headers["set-cookie"] || []).find((c) => c.startsWith(`${name}=`));
  return header ? header.split(";")[0] : null;
}

const app = express()
  .use(express.json())
  .use("/api/v1/connections", connectionRoutes())
  .use("/api/v1/admin/connections", adminConnectionRoutes())
  .use("/api/v1/admin/dashboard", dashboardRoutes())
  .use(errorHandler);

let teamId;
let otherTeamId;

async function insertConnection(team, realm) {
  const { rows } = await db.query(
    `INSERT INTO qbo_connections (team_id, realm_id, access_token_enc, refresh_token_enc, token_iv)
     VALUES ($1, $2, 'a', 'r', 'iv') RETURNING id`,
    [team, realm]
  );
  return rows[0].id;
}

async function insertJob(team, connectionId, type, status) {
  await db.query(
    "INSERT INTO jobs (team_id, connection_id, type, status) VALUES ($1, $2, $3, $4)",
    [team, connectionId, type, status]
  );
}

async function connect(realmId) {
  const start = await request(app).get("/api/v1/connections/authorize");
  const state = new URL(start.body.url).searchParams.get("state");
  const res = await request(app)
    .get("/api/v1/connections/callback")
    .set("Cookie", cookiePair(start, "eztd_qbo_connect"))
    .query({ code: "c", realmId, state });
  return res.headers.location;
}

describe("connection routes on PGlite", () => {
  beforeAll(async () => {
    await runMigrations({ closePool: false });
    teamId = (await db.query("INSERT INTO teams (name) VALUES ('t') RETURNING id")).rows[0].id;
    otherTeamId = (await db.query("INSERT INTO teams (name) VALUES ('o') RETURNING id")).rows[0].id;
    const userId = (
      await db.query("INSERT INTO users (email) VALUES ('u@example.com') RETURNING id")
    ).rows[0].id;
    await db.query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')", [
      teamId,
      userId
    ]);
    who.user = { id: userId, teamId, role: "owner" };
  }, 60_000);
  afterAll(async () => {
    await db.closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.query("DELETE FROM jobs");
    await db.query("DELETE FROM qbo_connections");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "a", refresh_token: "r" })
      })
    );
  });

  it("flags a connection with an earlier load however many jobs came after it", async () => {
    const loaded = await insertConnection(teamId, "realm-a");
    const fresh = await insertConnection(teamId, "realm-b");
    await insertJob(teamId, loaded, "load", "completed");
    for (let i = 0; i < 60; i++) await insertJob(teamId, null, "generate", "completed");
    await insertJob(teamId, fresh, "load", "failed");
    const res = await request(app).get("/api/v1/connections");
    const flags = Object.fromEntries(res.body.map((c) => [c.id, c.has_prior_load]));
    expect(flags).toEqual({ [loaded]: true, [fresh]: false });
  });

  it("refuses to disconnect a connection with an active job, then disconnects it once done", async () => {
    const id = await insertConnection(teamId, "realm-a");
    await insertJob(teamId, id, "load", "running");

    const refused = await request(app).delete(`/api/v1/connections/${id}`);
    expect(refused.status).toBe(409);
    const kept = await db.query("SELECT disconnected_at FROM qbo_connections WHERE id = $1", [id]);
    expect(kept.rows[0].disconnected_at).toBeNull();

    await db.query("UPDATE jobs SET status = 'completed'");
    const deleted = await request(app).delete(`/api/v1/connections/${id}`);
    expect(deleted.status).toBe(200);
    // The row stays (its jobs keep their sandbox) with the tokens gone, and is no longer listed.
    const { rows } = await db.query(
      `SELECT disconnected_at, access_token_enc, refresh_token_enc, token_iv
       FROM qbo_connections WHERE id = $1`,
      [id]
    );
    expect(rows[0]).toMatchObject({
      access_token_enc: null,
      refresh_token_enc: null,
      token_iv: null
    });
    expect(rows[0].disconnected_at).not.toBeNull();
    const jobs = await db.query("SELECT connection_id FROM jobs");
    expect(jobs.rows).toEqual([{ connection_id: id }]);
    expect((await request(app).get("/api/v1/connections")).body).toEqual([]);
  });

  it("keeps the sandbox's load history when it is disconnected and reconnected", async () => {
    const id = await insertConnection(teamId, "realm-a");
    await insertJob(teamId, id, "load", "completed");
    expect((await request(app).delete(`/api/v1/connections/${id}`)).status).toBe(200);

    expect(await connect("realm-a")).toBe("/home?connected=true");
    const after = await request(app).get("/api/v1/connections");
    expect(after.body).toHaveLength(1);
    expect(after.body[0]).toMatchObject({ id, has_prior_load: true });
  });

  it("refuses to use a disconnected sandbox: test, health and purge", async () => {
    const id = await insertConnection(teamId, "realm-a");
    expect((await request(app).delete(`/api/v1/connections/${id}`)).status).toBe(200);

    for (const res of [
      await request(app).post(`/api/v1/connections/${id}/test`),
      await request(app).get(`/api/v1/connections/${id}/health`),
      await request(app).post(`/api/v1/connections/${id}/purge`).send({})
    ]) {
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toMatch(/Reconnect/);
    }
    expect((await db.query("SELECT 1 FROM jobs")).rows).toHaveLength(0);
  });

  it("admin force-disconnect keeps the sandbox's history too, and the admin list shows connected ones", async () => {
    const id = await insertConnection(teamId, "realm-a");
    await insertJob(teamId, id, "load", "completed");
    expect((await request(app).delete(`/api/v1/admin/connections/${id}`)).status).toBe(200);
    expect((await request(app).get("/api/v1/admin/connections")).body).toMatchObject({
      connections: [],
      total: 0
    });

    expect(await connect("realm-a")).toBe("/home?connected=true");
    const after = await request(app).get("/api/v1/connections");
    expect(after.body[0]).toMatchObject({ id, has_prior_load: true });
  });

  it("admin force-disconnect is refused (409) like the team's while a job or the lock uses it", async () => {
    const { acquireConnectionLock, releaseConnectionLock } =
      await import("../src/services/connection-lock.js");
    const id = await insertConnection(teamId, "realm-a");
    const connected = async () =>
      (await db.query("SELECT disconnected_at FROM qbo_connections WHERE id = $1", [id])).rows[0]
        .disconnected_at === null;

    await insertJob(teamId, id, "load", "running");
    const busyJob = await request(app).delete(`/api/v1/admin/connections/${id}`);
    expect(busyJob.status).toBe(409);
    expect(busyJob.body.error).toMatch(/job/i);
    expect(await connected()).toBe(true);

    await db.query("UPDATE jobs SET status = 'completed'");
    const held = await acquireConnectionLock(id);
    try {
      expect((await request(app).delete(`/api/v1/admin/connections/${id}`)).status).toBe(409);
      expect(await connected()).toBe(true);
    } finally {
      await releaseConnectionLock(held);
    }

    expect((await request(app).delete(`/api/v1/admin/connections/${id}`)).status).toBe(200);
    expect(await connected()).toBe(false);
    // Already disconnected (or unknown): 404, as before.
    expect((await request(app).delete(`/api/v1/admin/connections/${id}`)).status).toBe(404);
  });

  it("resets the activity clock when an expired sandbox is reconnected", async () => {
    const id = await insertConnection(teamId, "realm-a");
    await db.query(
      `UPDATE qbo_connections SET connected_at = NOW() - INTERVAL '150 days',
         last_used_at = NOW() - INTERVAL '120 days' WHERE id = $1`,
      [id]
    );
    const before = await request(app).get("/api/v1/connections");
    expect(before.body[0].tokenHealth).toBe("expired");

    expect(await connect("realm-a")).toBe("/home?connected=true");

    const after = await request(app).get("/api/v1/connections");
    expect(after.body).toHaveLength(1);
    expect(after.body[0]).toMatchObject({ id, tokenHealth: "ok", last_used_at: null });
    const health = await request(app).get(`/api/v1/connections/${id}/health`);
    expect(health.body.status).toBe("healthy");
  });

  it("enforces the limit for new sandboxes only, and never counts another team's", async () => {
    await insertConnection(otherTeamId, "realm-x");
    expect(await connect("realm-a")).toBe("/home?connected=true");
    expect(await connect("realm-b")).toBe("/home?connected=true");
    // At the limit: a new sandbox is refused, reconnecting an existing one still works.
    expect(await connect("realm-c")).toBe("/home?error=connection_limit_reached");
    expect(await connect("realm-a")).toBe("/home?connected=true");
    const { rows } = await db.query(
      "SELECT realm_id FROM qbo_connections WHERE team_id = $1 ORDER BY realm_id",
      [teamId]
    );
    expect(rows.map((r) => r.realm_id)).toEqual(["realm-a", "realm-b"]);
  });

  it("does not count disconnected sandboxes, and reconnecting one counts it again", async () => {
    expect(await connect("realm-a")).toBe("/home?connected=true");
    expect(await connect("realm-b")).toBe("/home?connected=true");
    const { rows } = await db.query("SELECT id FROM qbo_connections WHERE realm_id = 'realm-a'");
    expect((await request(app).delete(`/api/v1/connections/${rows[0].id}`)).status).toBe(200);

    expect(await connect("realm-c")).toBe("/home?connected=true");
    // realm-b and realm-c are connected: bringing realm-a back would make three.
    expect(await connect("realm-a")).toBe("/home?error=connection_limit_reached");
    const listed = await request(app).get("/api/v1/connections");
    expect(listed.body.map((c) => c.realm_id).sort()).toEqual(["realm-b", "realm-c"]);
  });

  it("the connection test returns the company name QBO reports now", async () => {
    const { QboClient } = await import("@easytestdata/qbo-client");
    expect(await connect("realm-a")).toBe("/home?connected=true");
    const { rows } = await db.query("SELECT id FROM qbo_connections WHERE realm_id = 'realm-a'");
    await db.query("UPDATE qbo_connections SET company_name = 'Old Name' WHERE id = $1", [
      rows[0].id
    ]);
    // A `select` query answers with an array of CompanyInfo records.
    const spy = vi
      .spyOn(QboClient.prototype, "query")
      .mockResolvedValue({ QueryResponse: { CompanyInfo: [{ CompanyName: "Fresh Co" }] } });
    try {
      const res = await request(app).post(`/api/v1/connections/${rows[0].id}/test`);
      expect(res.body).toEqual({ ok: true, companyName: "Fresh Co" });
    } finally {
      spy.mockRestore();
    }
  });

  it("the admin funnel and connection count leave out disconnected sandboxes", async () => {
    await insertConnection(teamId, "realm-live");
    const gone = await insertConnection(teamId, "realm-gone");
    const otherGone = await insertConnection(otherTeamId, "realm-other");
    await db.query("UPDATE qbo_connections SET disconnected_at = NOW() WHERE id = ANY($1)", [
      [gone, otherGone]
    ]);

    const funnel = await request(app).get("/api/v1/admin/dashboard/conversion-funnel");
    // The team that disconnected its only sandbox no longer counts as connected.
    expect(funnel.body.connected).toBe(1);
    const kpis = await request(app).get("/api/v1/admin/dashboard");
    expect(kpis.body.activeConnections).toBe(1);
  });

  it("the admin stale filter counts idle time from the connection date when never used", async () => {
    const fresh = await insertConnection(teamId, "realm-new");
    const idle = await insertConnection(teamId, "realm-idle");
    const usedLongAgo = await insertConnection(teamId, "realm-old");
    await db.query(
      "UPDATE qbo_connections SET connected_at = NOW() - INTERVAL '90 days' WHERE id = ANY($1)",
      [[idle, usedLongAgo]]
    );
    await db.query(
      "UPDATE qbo_connections SET last_used_at = NOW() - INTERVAL '61 days' WHERE id = $1",
      [usedLongAgo]
    );

    const res = await request(app).get("/api/v1/admin/connections?stale=true");
    expect(res.body.connections.map((c) => c.id).sort()).toEqual([idle, usedLongAgo].sort());
    expect(res.body.total).toBe(2);
    expect(res.body.connections.map((c) => c.id)).not.toContain(fresh);
  });
});

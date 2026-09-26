import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// services/connection-guard.js's rule on the real schema (embedded PGlite): every path that
// changes a connection's state or queues a job on it locks the team row, then the connection
// row, then checks and writes. PGlite has one connection, so two requests fired together run one
// after the other; each pair below is fired together and must end in one of the two serialized
// outcomes, never both succeeding.
const dir = mkdtempSync(join(tmpdir(), "eztd-connection-guard-pglite-"));
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
const who = vi.hoisted(() => ({ user: null }));
// Runs between POST /jobs's request validation and its insert (the finding's race window).
const hooks = vi.hoisted(() => ({ afterValidation: null }));
vi.mock("../src/services/limits.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    enforceJobCreationLimits: async (...args) => {
      const result = await original.enforceJobCreationLimits(...args);
      await hooks.afterValidation?.();
      return result;
    }
  };
});
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
const { jobRoutes } = await import("../src/routes/jobs.js");
const { jobRoutes: adminJobRoutes } = await import("../src/routes/admin/jobs.js");
const { connectionRoutes: adminConnectionRoutes } =
  await import("../src/routes/admin/connections.js");
const { errorHandler } = await import("../src/middleware/error-handler.js");

const app = express()
  .use(express.json())
  .use("/api/v1/connections", connectionRoutes())
  .use("/api/v1/jobs", jobRoutes())
  .use("/api/v1/admin/jobs", adminJobRoutes())
  .use("/api/v1/admin/connections", adminConnectionRoutes())
  .use(errorHandler);

let teamId;
let userId;

async function insertConnection(realm = "realm-a") {
  const { rows } = await db.query(
    `INSERT INTO qbo_connections (team_id, realm_id, access_token_enc, refresh_token_enc, token_iv)
     VALUES ($1, $2, 'a', 'r', 'iv') RETURNING id`,
    [teamId, realm]
  );
  return rows[0].id;
}

async function insertJob(connectionId, type, status, extra = {}) {
  const { rows } = await db.query(
    `INSERT INTO jobs (team_id, connection_id, type, status, config, result)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      teamId,
      connectionId,
      type,
      status,
      JSON.stringify(extra.config || {}),
      extra.result ? JSON.stringify(extra.result) : null
    ]
  );
  return rows[0].id;
}

const disconnected = async (id) =>
  (await db.query("SELECT disconnected_at FROM qbo_connections WHERE id = $1", [id])).rows[0]
    .disconnected_at !== null;
const activeJobs = async (id) =>
  (
    await db.query(
      "SELECT COUNT(*)::int AS n FROM jobs WHERE connection_id = $1 AND status = 'pending'",
      [id]
    )
  ).rows[0].n;

/** The ways a job that uses the sandbox gets queued. Each returns the supertest request. */
const queueJob = {
  "POST /jobs (load)": (id) =>
    request(app)
      .post("/api/v1/jobs")
      .send({ type: "load", connectionId: id, templateId: "professional-services", config: {} }),
  "POST /jobs (purge)": (id) =>
    request(app)
      .post("/api/v1/jobs")
      .send({ type: "purge", connectionId: id, templateId: "professional-services", config: {} }),
  "POST /connections/:id/purge": (id) =>
    request(app).post(`/api/v1/connections/${id}/purge`).send({}),
  "POST /jobs/:id/rollback": async (id) => {
    const load = await insertJob(id, "load", "failed_with_orphans", {
      result: { ledger: { entities: {} } }
    });
    return request(app).post(`/api/v1/jobs/${load}/rollback`);
  },
  "POST /admin/jobs/:id/retry": async (id) => {
    const failed = await insertJob(id, "purge", "failed", { config: { tag: "EZTD" } });
    return request(app).post(`/api/v1/admin/jobs/${failed}/retry`);
  }
};

const disconnect = {
  team: (id) => request(app).delete(`/api/v1/connections/${id}`),
  admin: (id) => request(app).delete(`/api/v1/admin/connections/${id}`)
};

describe("the connection guard on PGlite", () => {
  beforeAll(async () => {
    await runMigrations({ closePool: false });
    teamId = (await db.query("INSERT INTO teams (name) VALUES ('t') RETURNING id")).rows[0].id;
    userId = (await db.query("INSERT INTO users (email) VALUES ('u@example.com') RETURNING id"))
      .rows[0].id;
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
    await db.query("UPDATE users SET suspended_at = NULL");
    await db.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')
       ON CONFLICT DO NOTHING`,
      [teamId, userId]
    );
  });

  for (const [path, queue] of Object.entries(queueJob)) {
    describe(path, () => {
      it("refuses a disconnected sandbox (409) and a missing one (404), queuing nothing", async () => {
        const id = await insertConnection();
        expect((await disconnect.team(id)).status).toBe(200);
        const refused = await queue(id);
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatch(/disconnected/);
        expect(await activeJobs(id)).toBe(0);

        // (A rollback or retry source always names an existing row: the foreign key.)
        if (!/rollback|retry/.test(path)) {
          const missing = await queue("99999999-9999-4999-8999-999999999999");
          expect(missing.status).toBe(404);
        }
      });

      for (const [who_, remove] of Object.entries(disconnect)) {
        it(`and a ${who_} disconnect fired together never both succeed`, async () => {
          const id = await insertConnection();
          const [queued, removed] = await Promise.all([queue(id), remove(id)]);
          // Either the job was queued first (the disconnect sees it and is refused) or the
          // disconnect ran first (the job insert sees a disconnected sandbox and is refused).
          if (queued.ok) {
            expect(removed.status).toBe(409);
            expect(await disconnected(id)).toBe(false);
            expect(await activeJobs(id)).toBe(1);
          } else {
            expect(queued.status).toBe(409);
            expect(removed.status).toBe(200);
            expect(await disconnected(id)).toBe(true);
            expect(await activeJobs(id)).toBe(0);
          }
        });
      }

      it("in order: job first, then the disconnect is refused; disconnect first, then the job", async () => {
        const first = await insertConnection("realm-1");
        expect((await queue(first)).ok).toBe(true);
        expect((await disconnect.team(first)).status).toBe(409);
        expect(await disconnected(first)).toBe(false);

        await db.query("DELETE FROM jobs");
        const second = await insertConnection("realm-2");
        expect((await disconnect.team(second)).status).toBe(200);
        expect((await queue(second)).status).toBe(409);
        expect(await activeJobs(second)).toBe(0);
      });
    });
  }

  it("POST /jobs: a disconnect landing after validation, before the insert, queues nothing", async () => {
    const id = await insertConnection();
    let removed;
    hooks.afterValidation = async () => {
      removed = await disconnect.team(id);
    };
    try {
      const queued = await queueJob["POST /jobs (load)"](id);
      expect(removed.status).toBe(200);
      expect(queued.status).toBe(409);
      expect(await activeJobs(id)).toBe(0);
    } finally {
      hooks.afterValidation = null;
    }
  });

  describe("admin retry of a load that left records in the sandbox", () => {
    const retry = (id) => request(app).post(`/api/v1/admin/jobs/${id}/retry`);
    async function orphanedLoad(connectionId, tag = "EZTD") {
      const id = await insertJob(connectionId, "load", "failed_with_orphans", {
        config: { tag },
        result: { ledger: { entities: {} } }
      });
      // Created a moment ago, so a Remove test data inserted next is "after" it.
      await db.query("UPDATE jobs SET created_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [id]);
      return id;
    }
    async function clearData(connectionId, config, when = "NOW()") {
      const id = await insertJob(connectionId, "purge", "completed", { config });
      await db.query(`UPDATE jobs SET created_at = ${when} WHERE id = $1`, [id]);
    }

    it("refuses (409) while the load's records remain, queuing nothing", async () => {
      const conn = await insertConnection();
      const load = await orphanedLoad(conn);
      const res = await retry(load);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/Roll it back or use "Remove test data" first/);
      expect(await activeJobs(conn)).toBe(0);
    });

    it("allows it once the load was rolled back (its status left failed_with_orphans)", async () => {
      const conn = await insertConnection();
      const load = await orphanedLoad(conn);
      await db.query("UPDATE jobs SET status = 'failed' WHERE id = $1", [load]);
      expect((await retry(load)).status).toBe(200);
    });

    it("allows it after a later Remove test data of its tag or of everything, not of another tag", async () => {
      const conn = await insertConnection();
      const load = await orphanedLoad(conn, "DEMO");
      await clearData(conn, { tag: "EZTD", purgeMode: "generated" });
      await clearData(conn, { tag: "DEMO", purgeMode: "generated" }, "NOW() - INTERVAL '2 hours'");
      expect((await retry(load)).status).toBe(409); // other tag, or before the load

      await clearData(conn, { tag: "demo", purgeMode: "generated" });
      expect((await retry(load)).status).toBe(200);

      await db.query("DELETE FROM jobs");
      const conn2 = await insertConnection("realm-2");
      const load2 = await orphanedLoad(conn2, "DEMO");
      await clearData(conn2, { tag: "EZTD", purgeMode: "all" });
      expect((await retry(load2)).status).toBe(200);
    });

    it("refuses a load failed at its timeout the same way (its work may have gone on)", async () => {
      const conn = await insertConnection();
      const load = await insertJob(conn, "load", "failed", {
        config: { tag: "EZTD" },
        result: { timedOut: true }
      });
      await db.query("UPDATE jobs SET created_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [
        load
      ]);
      expect((await retry(load)).status).toBe(409);
      await clearData(conn, { tag: "EZTD", purgeMode: "generated" });
      expect((await retry(load)).status).toBe(200);
    });

    it("allows a retry that clears its own orphans first (purgeMode generated or all)", async () => {
      const conn = await insertConnection();
      for (const purgeMode of ["generated", "all"]) {
        await db.query("DELETE FROM jobs");
        const load = await insertJob(conn, "load", "failed_with_orphans", {
          config: { tag: "EZTD", purgeMode },
          result: { ledger: { entities: {} } }
        });
        expect((await retry(load)).status).toBe(200);
      }
      await db.query("DELETE FROM jobs");
      const none = await orphanedLoad(conn);
      await db.query(`UPDATE jobs SET config = config || '{"purgeMode": "none"}' WHERE id = $1`, [
        none
      ]);
      expect((await retry(none)).status).toBe(409);
    });

    it("still retries a failed rollback of such a load", async () => {
      const conn = await insertConnection();
      const load = await orphanedLoad(conn);
      const { rows } = await db.query(
        `INSERT INTO jobs (team_id, connection_id, type, status, parent_job_id)
         VALUES ($1, $2, 'rollback', 'failed', $3) RETURNING id`,
        [teamId, conn, load]
      );
      const res = await retry(rows[0].id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ type: "rollback", parent_job_id: load });
    });
  });

  describe("OAuth callback", () => {
    function cookiePair(res, name) {
      const header = (res.headers["set-cookie"] || []).find((c) => c.startsWith(`${name}=`));
      return header ? header.split(";")[0] : null;
    }
    async function connectWhile(duringExchange) {
      const start = await request(app).get("/api/v1/connections/authorize");
      const state = new URL(start.body.url).searchParams.get("state");
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url) => {
          if (String(url).includes("tokens/bearer")) await duringExchange();
          return { ok: true, json: async () => ({ access_token: "a", refresh_token: "r" }) };
        })
      );
      try {
        const res = await request(app)
          .get("/api/v1/connections/callback")
          .set("Cookie", cookiePair(start, "eztd_qbo_connect"))
          .query({ code: "c", realmId: "realm-new", state });
        return res.headers.location;
      } finally {
        vi.unstubAllGlobals();
      }
    }
    const stored = async () =>
      (await db.query("SELECT 1 FROM qbo_connections WHERE realm_id = 'realm-new'")).rows.length;

    it("stores the tokens while the user is still a member", async () => {
      expect(await connectWhile(async () => {})).toBe("/home?connected=true");
      expect(await stored()).toBe(1);
    });

    it("does not store tokens when the user left the team during the token exchange", async () => {
      const location = await connectWhile(() =>
        db.query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2", [teamId, userId])
      );
      expect(location).toBe("/home?error=not_team_member");
      expect(await stored()).toBe(0);
    });

    it("does not store tokens when the user was suspended during the token exchange", async () => {
      const location = await connectWhile(() =>
        db.query("UPDATE users SET suspended_at = NOW() WHERE id = $1", [userId])
      );
      expect(location).toBe("/home?error=not_team_member");
      expect(await stored()).toBe(0);
    });

    it("does not reconnect a disconnected sandbox for a user removed during the exchange", async () => {
      const id = await insertConnection("realm-new");
      expect((await disconnect.team(id)).status).toBe(200);
      const location = await connectWhile(() =>
        db.query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2", [teamId, userId])
      );
      expect(location).toBe("/home?error=not_team_member");
      expect(await disconnected(id)).toBe(true);
    });
  });
});

// The rule only holds if nothing bypasses it: jobs are inserted in one place, and a connection's
// state (connected or disconnected) is written only by the two guarded functions.
describe("no path bypasses the connection guard", () => {
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const files = [];
  (function walk(d) {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".js")) files.push(path);
    }
  })(srcDir);
  const hits = (pattern) =>
    files.filter((f) => pattern.test(readFileSync(f, "utf8"))).map((f) => relative(srcDir, f));

  it("inserts jobs only through insertLimitedJob", () => {
    expect(hits(/INSERT INTO jobs/)).toEqual(["services/job-enqueue.js"]);
  });

  it("connects and disconnects sandboxes only in the guarded store and disconnect", () => {
    expect(hits(/INSERT INTO qbo_connections/)).toEqual(["routes/connections.js"]);
    expect(hits(/disconnected_at = (NOW\(\)|NULL)/).sort()).toEqual([
      "routes/connections.js",
      "services/connection-disconnect.js"
    ]);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// /refresh and /oauth/exchange against the real schema on an embedded PGlite database, so the
// converted transactions (row locks, rollback() early exits, helpers given the client) run for
// real instead of against a scripted fake client.
const dir = mkdtempSync(join(tmpdir(), "eztd-auth-pglite-"));
vi.stubEnv("DEPLOYMENT", "local");
vi.stubEnv("EASYTESTDATA_DATA_DIR", dir);

vi.mock("../src/auth/passport-setup.js", () => ({ setupPassportStrategies: () => {} }));
// A slow database: every query outside a transaction takes a few milliseconds, so concurrent
// requests that use autocommit queries interleave (as they do on a loaded pg server).
vi.mock("../src/db/pool.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    query: async (text, params) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return real.query(text, params);
    }
  };
});
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

const db = await import("../src/db/pool.js");
const { runMigrations } = await import("../src/db/migrate.js");
const { issueSession } = await import("../src/auth/session.js");
const { oauthCodes } = await import("../src/state/memory.js");
const { authRoutes } = await import("../src/routes/auth.js");

const app = express();
app.use(express.json());
app.use("/api/v1/auth", authRoutes());

async function createUser(email, { withTeam = true } = {}) {
  const user = (
    await db.query(
      `INSERT INTO users (email, display_name, oauth_provider, oauth_provider_id)
       VALUES ($1, $2, 'google', $1) RETURNING *`,
      [email, email.split("@")[0]]
    )
  ).rows[0];
  if (!withTeam) return { user, membership: null };
  const team = (await db.query("INSERT INTO teams (name) VALUES ('t') RETURNING id")).rows[0];
  await db.query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')", [
    team.id,
    user.id
  ]);
  await db.query("UPDATE users SET active_team_id = $2 WHERE id = $1", [user.id, team.id]);
  return { user, membership: { teamId: team.id, role: "owner" } };
}

async function sessionVersion(userId) {
  const { rows } = await db.query("SELECT session_version FROM users WHERE id = $1", [userId]);
  return Number(rows[0].session_version);
}

function codeFor(user, overrides = {}) {
  const code = `code-${Math.random().toString(36).slice(2)}`;
  oauthCodes.set(
    code,
    {
      userId: user.id,
      sessionVersion: Number(user.session_version),
      provider: user.oauth_provider,
      providerId: user.oauth_provider_id,
      ...overrides
    },
    120_000
  );
  return code;
}

describe("auth routes on PGlite", () => {
  beforeAll(async () => runMigrations({ closePool: false }), 60_000);
  afterAll(async () => {
    await db.closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rotates a refresh token, revokes everything on late reuse, and refuses the new token after", async () => {
    const { user, membership } = await createUser("refresh@example.com");
    const { refreshToken } = await issueSession(user, membership);

    const first = await request(app).post("/api/v1/auth/refresh").send({ refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).toMatch(/^[0-9a-f]{96}$/);
    expect(first.body.refreshToken).not.toBe(refreshToken);

    // The rotated token comes back after the 30 s grace: sign the user out everywhere.
    await db.query(
      "UPDATE refresh_tokens SET used_at = NOW() - interval '1 minute' WHERE used_at IS NOT NULL"
    );
    const reuse = await request(app).post("/api/v1/auth/refresh").send({ refreshToken });
    expect(reuse.status).toBe(401);
    expect(await sessionVersion(user.id)).toBe(1);

    const after = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: first.body.refreshToken });
    expect(after.status).toBe(401);
  });

  it("rejects a reused token within the grace without revoking, and leaves nothing half-written", async () => {
    const { user, membership } = await createUser("grace@example.com");
    const { refreshToken } = await issueSession(user, membership);
    expect((await request(app).post("/api/v1/auth/refresh").send({ refreshToken })).status).toBe(
      200
    );
    const again = await request(app).post("/api/v1/auth/refresh").send({ refreshToken });
    expect(again.status).toBe(401);
    expect(await sessionVersion(user.id)).toBe(0);
    const { rows } = await db.query(
      "SELECT COUNT(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND used_at IS NULL",
      [user.id]
    );
    expect(rows[0].n).toBe(1); // the token issued by the first refresh is still usable
  });

  it("exchanges an OAuth code once, and refuses one from an older session generation", async () => {
    const { user, membership } = await createUser("exchange@example.com");
    const code = codeFor(user);
    const ok = await request(app).post("/api/v1/auth/oauth/exchange").send({ code });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ teamId: membership.teamId, user: { id: user.id } });
    expect(ok.body.accessToken).toBeTruthy();
    expect(ok.body.refreshToken).toBeTruthy();

    const replay = await request(app).post("/api/v1/auth/oauth/exchange").send({ code });
    expect(replay.status).toBe(400);

    await db.query("UPDATE users SET session_version = session_version + 1 WHERE id = $1", [
      user.id
    ]);
    const stale = await request(app)
      .post("/api/v1/auth/oauth/exchange")
      .send({ code: codeFor(user) }); // minted for generation 0; the user is now on 1
    expect(stale.status).toBe(400);
  });

  it("gives a new user exactly one owned team when two first sign-ins exchange at once", async () => {
    const { user } = await createUser("first@example.com", { withTeam: false });
    const [a, b] = await Promise.all([
      request(app)
        .post("/api/v1/auth/oauth/exchange")
        .send({ code: codeFor(user) }),
      request(app)
        .post("/api/v1/auth/oauth/exchange")
        .send({ code: codeFor(user) })
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.teamId).toBe(b.body.teamId);
    const { rows } = await db.query("SELECT team_id, role FROM team_members WHERE user_id = $1", [
      user.id
    ]);
    expect(rows).toEqual([{ team_id: a.body.teamId, role: "owner" }]);
    const active = await db.query("SELECT active_team_id FROM users WHERE id = $1", [user.id]);
    expect(active.rows[0].active_team_id).toBe(a.body.teamId);
  });
});

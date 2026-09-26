import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TEAM_ID = "11111111-1111-4111-8111-111111111111";

// One in-memory user row that the SQL stubs below read and mutate, so the flows under test
// (sign-in, switch-team, admin revoke) observe each other's writes like the DB would.
const state = vi.hoisted(() => ({ user: null }));
const queryMock = vi.fn();

vi.mock("../src/db/pool.js", async () => {
  const { fakeTransaction } = await import("./fake-transaction.js");
  return {
    query: (...args) => queryMock(...args),
    // Transactions (session issuance / revocation, the OAuth exchange) use a client delegating
    // to the same stub so every flow sees the one in-memory user row.
    ...fakeTransaction(() => ({ query: (...args) => queryMock(...args) }))
  };
});

vi.mock("../src/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
}));
vi.mock("../src/auth/passport-setup.js", () => ({ setupPassportStrategies: () => {} }));
vi.mock("../src/services/admin-bootstrap.js", () => ({
  applyAdminBootstrap: () => Promise.resolve(false)
}));

import { authenticate } from "../src/middleware/auth.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { authRoutes } from "../src/routes/auth.js";
import { userRoutes } from "../src/routes/admin/users.js";
import { generateTokens } from "../src/auth/session.js";
import { sessionVersionMatches, signAccessToken } from "../src/auth/tokens.js";

function installQueryStub() {
  queryMock.mockImplementation(async (sql, params) => {
    const u = state.user;
    if (sql.includes("SELECT * FROM users WHERE id")) return { rows: [{ ...u }] };
    if (sql.includes("SELECT id FROM users WHERE id")) return { rows: [{ id: u.id }] };
    if (sql.includes("SELECT session_version FROM users"))
      return { rows: [{ session_version: u.session_version }] };
    if (sql.includes("SET session_version = session_version + 1")) {
      u.session_version += 1;
      return { rows: [{ session_version: u.session_version }] };
    }
    if (sql.includes("json_object_agg")) {
      // authenticate's per-request user lookup
      return {
        rows: [
          {
            id: u.id,
            suspended_at: null,
            is_admin: false,
            session_version: u.session_version,
            memberships: { [TEAM_ID]: "owner" }
          }
        ]
      };
    }
    if (sql.includes("tm.team_id = u.active_team_id")) {
      return { rows: [{ team_id: TEAM_ID, role: "owner" }] };
    }
    if (sql.includes("SELECT role FROM team_members")) return { rows: [{ role: "owner" }] };
    if (sql.includes("INSERT INTO refresh_tokens")) {
      // The guarded insert only stores a token for the current session generation.
      return { rows: [], rowCount: Number(params?.[3]) === u.session_version ? 1 : 0 };
    }
    return { rows: [] };
  });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/auth", authRoutes());
  app.use("/api/v1/admin/users", userRoutes());
  app.get("/api/v1/jobs", authenticate, (req, res) =>
    res.json({ ok: true, teamId: req.user.teamId })
  );
  app.use(errorHandler);
  return app;
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

describe("access tokens are bound to the user's session version", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user = {
      id: "u1",
      email: "victim@x.com",
      display_name: "Victim",
      oauth_provider: "google",
      oauth_provider_id: "g-1",
      suspended_at: null,
      active_team_id: TEAM_ID,
      session_version: 0
    };
    installQueryStub();
  });

  it("carries the users row's session_version as `sv`", () => {
    const { accessToken } = generateTokens({ ...state.user, session_version: 7 }, TEAM_ID, "owner");
    expect(jwt.decode(accessToken).sv).toBe(7);
  });

  it("a signed-out-everywhere token can neither authenticate nor mint a session", async () => {
    const app = makeApp();
    // Someone holds a live 15-minute access token (e.g. a stolen one).
    const { accessToken: staleToken } = generateTokens(state.user, TEAM_ID, "owner");
    expect((await request(app).get("/api/v1/jobs").set(bearer(staleToken))).status).toBe(200);

    // Sign out everywhere (the same revocation refresh-token reuse triggers).
    let res = await request(app).post("/api/v1/admin/users/u1/revoke-sessions");
    expect(res.status).toBe(200);
    expect(state.user.session_version).toBe(1);

    res = await request(app).get("/api/v1/jobs").set(bearer(staleToken));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SESSION_REVOKED");

    // ... so it cannot mint a fresh 30-day refresh token through switch-team either.
    res = await request(app)
      .post("/api/v1/auth/switch-team")
      .set(bearer(staleToken))
      .send({ teamId: TEAM_ID });
    expect(res.status).toBe(401);
    expect(queryMock.mock.calls.some(([sql]) => sql.includes("INSERT INTO refresh_tokens"))).toBe(
      false
    );

    // A token issued in the new generation works.
    const ownerRes = await request(app)
      .get("/api/v1/jobs")
      .set(bearer(generateTokens(state.user, TEAM_ID, "owner").accessToken));
    expect(ownerRes.status).toBe(200);
  });

  it("admin revoke-sessions kills live access tokens too", async () => {
    const app = makeApp();
    const { accessToken } = generateTokens(state.user, TEAM_ID, "owner");
    expect((await request(app).get("/api/v1/jobs").set(bearer(accessToken))).status).toBe(200);

    const res = await request(app)
      .post("/api/v1/admin/users/u1/revoke-sessions")
      .set(bearer(accessToken));
    expect(res.status).toBe(200);
    expect(state.user.session_version).toBe(1);
    expect((await request(app).get("/api/v1/jobs").set(bearer(accessToken))).status).toBe(401);
  });

  it("rejects an access token that carries no session version at all", async () => {
    const app = makeApp();
    const noVersion = signAccessToken({
      sub: state.user.id,
      email: state.user.email,
      teamId: TEAM_ID,
      role: "owner"
    });
    const res = await request(app).get("/api/v1/jobs").set(bearer(noVersion));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SESSION_REVOKED");
    expect(sessionVersionMatches({}, { session_version: 0 })).toBe(false);
    expect(sessionVersionMatches({ sv: "0" }, { session_version: 0 })).toBe(false);
    expect(sessionVersionMatches({ sv: 0 }, { session_version: 0 })).toBe(true);
  });

  it("switch-team cannot mint a session when a revocation lands after authentication", async () => {
    const app = makeApp();
    const { accessToken } = generateTokens(state.user, TEAM_ID, "owner");
    // The request authenticates against generation 0; an admin revoke (or refresh-token reuse) then
    // completes before the handler stores its new refresh token.
    const base = queryMock.getMockImplementation();
    queryMock.mockImplementation(async (sql, params) => {
      if (sql.includes("SELECT * FROM users WHERE id")) state.user.session_version = 1;
      return base(sql, params);
    });

    const res = await request(app)
      .post("/api/v1/auth/switch-team")
      .set(bearer(accessToken))
      .send({ teamId: TEAM_ID });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SESSION_REVOKED");
    expect(res.body.accessToken).toBeUndefined();
    // Issuance locks the users row and compares the generation the request authenticated in
    // (0) with the current one (1) before storing anything, inside its own transaction.
    const calls = queryMock.mock.calls.map(([sql]) => sql);
    expect(calls.some((sql) => sql.includes("INSERT INTO refresh_tokens"))).toBe(false);
    const lockIdx = calls.findIndex((sql) => sql.includes("SELECT session_version FROM users"));
    expect(calls[lockIdx]).toContain("FOR NO KEY UPDATE");
    expect(calls.lastIndexOf("BEGIN")).toBeLessThan(lockIdx);
    expect(calls.lastIndexOf("ROLLBACK")).toBeGreaterThan(lockIdx);
    expect(calls).not.toContain("COMMIT");
  });

  it("switch-team issues the new session for the generation the request authenticated in", async () => {
    const app = makeApp();
    const { accessToken } = generateTokens(state.user, TEAM_ID, "owner");
    const res = await request(app)
      .post("/api/v1/auth/switch-team")
      .set(bearer(accessToken))
      .send({ teamId: TEAM_ID });
    expect(res.status).toBe(200);
    expect(jwt.decode(res.body.accessToken).sv).toBe(0);
    const store = queryMock.mock.calls.find(([sql]) => sql.includes("INSERT INTO refresh_tokens"));
    expect(store[1][3]).toBe(0);
  });
});

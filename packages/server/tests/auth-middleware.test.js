import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args) => queryMock(...args)
}));

vi.mock("../src/logger.js", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn()
  }
}));

import { authenticate } from "../src/middleware/auth.js";
import { signStateToken, STATE_TYPES } from "../src/auth/tokens.js";
import { config } from "../src/config.js";
import { signTestToken } from "./utils.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.get("/api/v1/jobs", authenticate, (req, res) => res.json({ ok: true, userId: req.user.id }));
  app.get("/api/v1/auth/profile", authenticate, (_req, res) => res.json({ ok: true }));
  return app;
}

function signToken(sub = "user-1") {
  return signTestToken({ sub });
}

describe("authenticate middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockReset();
  });

  it("refuses a token whose generation fell behind on the very next request", async () => {
    // Every request reads the user from the database: once a revocation bumps
    // users.session_version, the next request with an older token is refused.
    const user = { id: "user-1", suspended_at: null, memberships: { "team-1": "owner" } };
    queryMock.mockResolvedValueOnce({ rows: [{ ...user, session_version: 0 }] });
    const app = makeApp();
    const token = signTestToken({ sub: "user-1", teamId: "team-1", sv: 0 });
    const before = await request(app).get("/api/v1/jobs").set("Authorization", `Bearer ${token}`);
    expect(before.status).toBe(200);

    queryMock.mockResolvedValueOnce({ rows: [{ ...user, session_version: 1 }] });
    const after = await request(app).get("/api/v1/jobs").set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe("SESSION_REVOKED");
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("refuses a user suspended since their previous request", async () => {
    const user = { id: "user-1", session_version: 0, memberships: { "team-1": "owner" } };
    queryMock.mockResolvedValueOnce({ rows: [{ ...user, suspended_at: null }] });
    const app = makeApp();
    const token = signTestToken({ sub: "user-1", teamId: "team-1", sv: 0 });
    const before = await request(app).get("/api/v1/jobs").set("Authorization", `Bearer ${token}`);
    expect(before.status).toBe(200);

    queryMock.mockResolvedValueOnce({
      rows: [{ ...user, suspended_at: new Date().toISOString() }]
    });
    const after = await request(app).get("/api/v1/jobs").set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(403);
    expect(after.body.error).toContain("suspended");
  });

  it("rejects token in query string when Authorization header is absent", async () => {
    const app = makeApp();
    const token = signToken();

    const res = await request(app).get(`/api/v1/jobs?token=${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Authorization header required");
  });

  it("rejects suspended JWT user", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: "user-1", suspended_at: new Date().toISOString() }]
    });

    const app = makeApp();
    const token = signToken("user-1");
    const res = await request(app).get("/api/v1/jobs").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("suspended");
  });

  it("lets a signed-in user reach protected endpoints", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "user-1",
          suspended_at: null,
          memberships: { "team-1": "owner" }
        }
      ]
    });

    const app = makeApp();
    const token = signToken("user-1");
    const res = await request(app).get("/api/v1/jobs").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.userId).toBe("user-1");
  });

  it("returns service unavailable when JWT user lookup fails", async () => {
    queryMock.mockRejectedValueOnce(new Error("database unavailable"));

    const app = makeApp();
    const token = signToken("user-1");
    const res = await request(app).get("/api/v1/jobs").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("Authentication service unavailable");
  });

  it("rejects a bearer that is not a JWT without a database lookup", async () => {
    const app = makeApp();
    const res = await request(app).get("/api/v1/jobs").set("Authorization", "Bearer not-a-jwt");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid or expired token");
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("authenticate middleware token audience/type", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockResolvedValue({
      rows: [
        {
          id: "user-1",
          suspended_at: null,
          memberships: { "team-1": "owner" }
        }
      ]
    });
  });

  it("rejects an OAuth state token presented as an access token", async () => {
    const state = signStateToken(STATE_TYPES.qboConnect, {
      sub: "user-1",
      userId: "user-1",
      teamId: "team-1"
    });
    const res = await request(makeApp())
      .get("/api/v1/jobs")
      .set("Authorization", `Bearer ${state}`);
    expect(res.status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects a correctly signed JWT without the access audience/typ", async () => {
    const unscoped = jwt.sign(
      { sub: "user-1", teamId: "team-1", role: "owner" },
      config.jwt.secret,
      {
        issuer: config.jwt.issuer,
        expiresIn: "15m"
      }
    );
    const res = await request(makeApp())
      .get("/api/v1/jobs")
      .set("Authorization", `Bearer ${unscoped}`);
    expect(res.status).toBe(401);
  });

  it("rejects a token with the access audience but a different typ", async () => {
    const wrongTyp = jwt.sign(
      { sub: "user-1", teamId: "team-1", role: "owner", typ: "refresh" },
      config.jwt.secret,
      { issuer: config.jwt.issuer, audience: "easytestdata:access", expiresIn: "15m" }
    );
    const res = await request(makeApp())
      .get("/api/v1/jobs")
      .set("Authorization", `Bearer ${wrongTyp}`);
    expect(res.status).toBe(401);
  });
});

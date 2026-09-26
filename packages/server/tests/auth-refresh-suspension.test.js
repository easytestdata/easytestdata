import crypto from "crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const clientQueryMock = vi.fn();
const releaseMock = vi.fn();

vi.mock("../src/db/pool.js", async () => {
  const { fakeTransaction } = await import("./fake-transaction.js");
  return {
    query: (...args) => queryMock(...args),
    ...fakeTransaction(() => ({
      query: (...args) => clientQueryMock(...args),
      release: releaseMock
    }))
  };
});

vi.mock("../src/auth/passport-setup.js", () => ({
  setupPassportStrategies: () => {}
}));

import { authRoutes } from "../src/routes/auth.js";

describe("POST /auth/refresh suspension handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects suspended users during refresh", async () => {
    const refreshToken = "refresh-token-1";
    const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");

    clientQueryMock.mockImplementation((sql) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("SELECT user_id FROM refresh_tokens")) {
        return Promise.resolve({ rows: [{ user_id: "user-1" }] });
      }
      if (sql.includes("UPDATE refresh_tokens SET used_at")) {
        return Promise.resolve({ rows: [{ user_id: "user-1" }] });
      }
      if (sql.includes("SELECT email, display_name, suspended_at, session_version FROM users")) {
        return Promise.resolve({
          rows: [{ email: "u@example.com", display_name: "User", suspended_at: new Date() }]
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = express();
    app.use(express.json());
    app.use("/api/v1/auth", authRoutes());

    const res = await request(app).post("/api/v1/auth/refresh").send({ refreshToken });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("suspended");
    expect(clientQueryMock).toHaveBeenCalledWith("BEGIN");
    expect(clientQueryMock).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE refresh_tokens SET used_at"),
      [tokenHash]
    );
    expect(clientQueryMock).toHaveBeenCalledWith("COMMIT");
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it("rolls back when refresh rotation fails after consuming the old token", async () => {
    const refreshToken = "refresh-token-2";

    clientQueryMock.mockImplementation((sql) => {
      if (["BEGIN", "ROLLBACK"].includes(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("SELECT user_id FROM refresh_tokens")) {
        return Promise.resolve({ rows: [{ user_id: "user-2" }] });
      }
      if (sql.includes("UPDATE refresh_tokens SET used_at")) {
        return Promise.resolve({ rows: [{ user_id: "user-2" }] });
      }
      if (sql.includes("SELECT email, display_name, suspended_at, session_version FROM users")) {
        return Promise.reject(new Error("database unavailable"));
      }
      return Promise.resolve({ rows: [] });
    });

    const app = express();
    app.use(express.json());
    app.use("/api/v1/auth", authRoutes());

    const res = await request(app).post("/api/v1/auth/refresh").send({ refreshToken });
    expect(res.status).toBe(500);
    expect(clientQueryMock).toHaveBeenCalledWith("BEGIN");
    expect(clientQueryMock).toHaveBeenCalledWith("ROLLBACK");
    expect(clientQueryMock).not.toHaveBeenCalledWith("COMMIT");
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/v1/auth", authRoutes());
    return app;
  }

  it("revokes every session when a rotated refresh token is presented again", async () => {
    clientQueryMock.mockImplementation((sql) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("UPDATE refresh_tokens SET used_at")) return Promise.resolve({ rows: [] });
      if (sql.includes("SELECT user_id, used_at")) {
        return Promise.resolve({ rows: [{ user_id: "user-3", within_grace: false }] });
      }
      if (sql.includes("SELECT session_version FROM users")) {
        return Promise.resolve({ rows: [{ session_version: 0 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(makeApp())
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: "stolen-rotated-token" });

    expect(res.status).toBe(401);
    expect(clientQueryMock).toHaveBeenCalledWith("DELETE FROM refresh_tokens WHERE user_id = $1", [
      "user-3"
    ]);
    // "Sign out everywhere" includes live access tokens: the session generation moves on inside
    // the same transaction.
    expect(clientQueryMock).toHaveBeenCalledWith(
      expect.stringContaining("SET session_version = session_version + 1"),
      ["user-3"]
    );
    const calls = clientQueryMock.mock.calls.map(([sql]) => sql);
    expect(calls.findIndex((sql) => sql.includes("session_version + 1"))).toBeLessThan(
      calls.indexOf("COMMIT")
    );
    expect(clientQueryMock).toHaveBeenCalledWith("COMMIT");
    // The revocation locks the users row before bumping.
    expect(calls.findIndex((sql) => sql.includes("FOR NO KEY UPDATE"))).toBeLessThan(
      calls.findIndex((sql) => sql.includes("session_version + 1"))
    );
  });

  it("refuses a refresh token issued in a generation that has since been revoked", async () => {
    // The token row survived a revocation's DELETE (it was stored concurrently with it); its
    // recorded generation (0) is behind the user's (1), so it must not adopt the new one.
    clientQueryMock.mockImplementation((sql) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return Promise.resolve({ rows: [] });
      if (sql.includes("SELECT user_id FROM refresh_tokens")) {
        return Promise.resolve({ rows: [{ user_id: "user-4" }] });
      }
      if (sql.includes("UPDATE refresh_tokens SET used_at")) {
        expect(sql).toContain("RETURNING user_id, session_version");
        return Promise.resolve({ rows: [{ user_id: "user-4", session_version: 0 }] });
      }
      if (sql.includes("SELECT email, display_name, suspended_at, session_version FROM users")) {
        return Promise.resolve({
          rows: [{ email: "u4@x.com", display_name: "U4", suspended_at: null, session_version: 1 }]
        });
      }
      if (sql.includes("SELECT session_version FROM users")) {
        return Promise.resolve({ rows: [{ session_version: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(makeApp())
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: "stale-generation-token" });
    expect(res.status).toBe(401);
    expect(res.body.accessToken).toBeUndefined();
    const calls = clientQueryMock.mock.calls.map(([sql]) => sql);
    expect(calls.some((sql) => sql.includes("INSERT INTO refresh_tokens"))).toBe(false);
    expect(calls).toContain("COMMIT"); // the presented token stays consumed
  });

  it("locks the owner's users row before claiming the token (the order revocations take)", async () => {
    // A revocation locks the users row and then deletes the user's refresh tokens; a refresh
    // that claimed its token row first and then waited for the users row would deadlock with it.
    clientQueryMock.mockImplementation((sql) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return Promise.resolve({ rows: [] });
      if (sql.includes("SELECT user_id FROM refresh_tokens")) {
        return Promise.resolve({ rows: [{ user_id: "user-5" }] });
      }
      if (sql.includes("UPDATE refresh_tokens SET used_at")) {
        return Promise.resolve({ rows: [{ user_id: "user-5", session_version: 0 }] });
      }
      if (sql.includes("SELECT email, display_name, suspended_at, session_version FROM users")) {
        return Promise.resolve({
          rows: [{ email: "u5@x.com", display_name: "U5", suspended_at: null, session_version: 0 }]
        });
      }
      if (sql.includes("SELECT session_version FROM users")) {
        return Promise.resolve({ rows: [{ session_version: 0 }] });
      }
      if (sql.includes("tm.team_id = u.active_team_id")) {
        return Promise.resolve({ rows: [{ team_id: "team-5", role: "owner" }] });
      }
      if (sql.includes("INSERT INTO refresh_tokens"))
        return Promise.resolve({ rows: [], rowCount: 1 });
      return Promise.resolve({ rows: [] });
    });

    const res = await request(makeApp())
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: "live-token" });
    expect(res.status).toBe(200);
    const calls = clientQueryMock.mock.calls.map(([sql]) => sql);
    const lock = calls.findIndex((sql) => sql.includes("FOR NO KEY UPDATE"));
    expect(lock).toBeGreaterThan(-1);
    expect(clientQueryMock.mock.calls[lock][1]).toEqual(["user-5"]);
    expect(lock).toBeLessThan(calls.findIndex((sql) => sql.includes("UPDATE refresh_tokens")));
  });

  it("only rejects (no revocation) when reuse happens within the concurrent-refresh grace", async () => {
    clientQueryMock.mockImplementation((sql) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return Promise.resolve({ rows: [] });
      if (sql.includes("UPDATE refresh_tokens SET used_at")) return Promise.resolve({ rows: [] });
      if (sql.includes("SELECT user_id, used_at")) {
        return Promise.resolve({ rows: [{ user_id: "user-3", within_grace: true }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(makeApp())
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: "just-rotated-token" });

    expect(res.status).toBe(401);
    expect(
      clientQueryMock.mock.calls.some(
        ([sql]) =>
          sql.startsWith("DELETE FROM refresh_tokens WHERE user_id = $1") &&
          !sql.includes("expires_at")
      )
    ).toBe(false);
  });

  it("rejects unknown refresh tokens without touching other sessions", async () => {
    clientQueryMock.mockImplementation((sql) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(makeApp())
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: "never-issued" });
    expect(res.status).toBe(401);
    expect(clientQueryMock).toHaveBeenCalledWith("ROLLBACK");
  });
});

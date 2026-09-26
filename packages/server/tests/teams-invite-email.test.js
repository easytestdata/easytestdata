import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const getClientMock = vi.fn();
const clientQueryMock = vi.fn();
const clientReleaseMock = vi.fn();
const getLimitsMock = vi.fn();
const authState = vi.hoisted(() => ({
  user: { id: "user-1", teamId: "team-1", role: "owner" }
}));

vi.mock("../src/middleware/auth.js", async () => {
  const actual = await vi.importActual("../src/middleware/auth.js");
  return {
    ...actual,
    authenticate: (req, _res, next) => {
      req.user = authState.user;
      next();
    }
  };
});

vi.mock("../src/db/pool.js", async () => {
  const { fakeTransaction } = await import("./fake-transaction.js");
  return {
    ...fakeTransaction((...args) => getClientMock(...args)),
    query: (...args) => queryMock(...args)
  };
});

vi.mock("../src/services/limits.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getLimits: (...args) => getLimitsMock(...args)
}));

import { teamRoutes } from "../src/routes/teams.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/teams", teamRoutes());
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || err.status || 500).json({ error: err.message });
  });
  return app;
}

function isSeatUsageQuery(sql) {
  return sql.includes("AS member_count") && sql.includes("AS pending_invite_count");
}

function expectSeatUsageExcludesExistingMemberInvites(sql) {
  expect(sql).toContain("NOT EXISTS");
  expect(sql).toContain("JOIN users");
  expect(sql).toContain("LOWER(u.email) = LOWER(team_invites.email)");
}

describe("team invites (canonical email, shareable link)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: "user-1", teamId: "team-1", role: "owner" };
    getLimitsMock.mockReturnValue({ teamMembers: -1 });
    getClientMock.mockResolvedValue({
      query: (...args) => clientQueryMock(...args),
      release: clientReleaseMock
    });
  });

  it("stores invite email as lowercase+trimmed canonical value", async () => {
    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM team_members WHERE team_id = $1")) {
        return Promise.resolve({
          rows: [{ team_id: "team-1", user_id: "user-1", role: "owner" }]
        });
      }

      return Promise.resolve({ rows: [] });
    });

    clientQueryMock.mockImplementation((sql, params) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql.startsWith("SELECT pg_advisory")) {
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes("FROM team_invites") && sql.includes("email = $2")) {
        return Promise.resolve({ rows: [] });
      }

      if (isSeatUsageQuery(sql)) {
        expectSeatUsageExcludesExistingMemberInvites(sql);
        return Promise.resolve({ rows: [{ member_count: 1, pending_invite_count: 0 }] });
      }

      if (sql.includes("INSERT INTO team_invites")) {
        expect(params[1]).toBe("invitee@example.com");
        return Promise.resolve({
          rows: [
            {
              id: "invite-1",
              email: "invitee@example.com",
              role: "member",
              expires_at: new Date().toISOString(),
              created_at: new Date().toISOString()
            }
          ]
        });
      }

      return Promise.resolve({ rows: [] });
    });

    const app = makeApp();
    const res = await request(app).post("/api/v1/teams/team-1/invites").send({
      email: "  Invitee@Example.com  ",
      role: "member"
    });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe("invitee@example.com");
    // Nothing sends email: the inviter always gets the link to share.
    expect(res.body.inviteUrl).toMatch(/\/invite\?token=[0-9a-f]+$/);
  });

  it("re-issues the link of an existing active invite without inserting another", async () => {
    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM team_members WHERE team_id = $1")) {
        return Promise.resolve({
          rows: [{ team_id: "team-1", user_id: "user-1", role: "owner" }]
        });
      }

      return Promise.resolve({ rows: [] });
    });

    clientQueryMock.mockImplementation((sql, params) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql.startsWith("SELECT pg_advisory")) {
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes("FROM team_invites") && sql.includes("email = $2")) {
        expect(params).toEqual(["team-1", "invitee@example.com"]);
        return Promise.resolve({
          rows: [
            {
              id: "invite-existing",
              email: "invitee@example.com",
              role: "member",
              expires_at: new Date().toISOString(),
              created_at: new Date().toISOString()
            }
          ]
        });
      }

      if (sql.includes("INSERT INTO team_invites")) {
        throw new Error("duplicate invite should not insert");
      }

      if (sql.includes("UPDATE team_invites SET token = $1, role = $2, expires_at = $3")) {
        return Promise.resolve({
          rows: [{ id: params[3], email: "invitee@example.com", role: params[1] }]
        });
      }

      return Promise.resolve({ rows: [] });
    });

    const app = makeApp();
    const res = await request(app).post("/api/v1/teams/team-1/invites").send({
      email: "Invitee@Example.com",
      role: "member"
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "invite-existing",
      email: "invitee@example.com",
      alreadyPending: true
    });
    // Only the token's hash is stored, so a fresh token replaces the old link.
    expect(res.body.inviteUrl).toMatch(/\/invite\?token=[0-9a-f]+$/);
    expect(
      clientQueryMock.mock.calls.some(([sql]) =>
        sql.includes("UPDATE team_invites SET token = $1, role = $2, expires_at = $3")
      )
    ).toBe(true);
    expect(clientReleaseMock).toHaveBeenCalledTimes(1);
  });

  it("counts active pending invites against the team member limit", async () => {
    getLimitsMock.mockReturnValue({ teamMembers: 2 });
    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM team_members WHERE team_id = $1")) {
        return Promise.resolve({
          rows: [{ team_id: "team-1", user_id: "user-1", role: "owner" }]
        });
      }

      return Promise.resolve({ rows: [] });
    });

    clientQueryMock.mockImplementation((sql) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql.startsWith("SELECT pg_advisory")) {
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes("FROM team_invites") && sql.includes("email = $2")) {
        return Promise.resolve({ rows: [] });
      }

      if (isSeatUsageQuery(sql)) {
        expectSeatUsageExcludesExistingMemberInvites(sql);
        return Promise.resolve({ rows: [{ member_count: 1, pending_invite_count: 1 }] });
      }

      if (sql.includes("INSERT INTO team_invites")) {
        throw new Error("member cap should prevent another pending invite");
      }

      return Promise.resolve({ rows: [] });
    });

    const app = makeApp();
    const res = await request(app).post("/api/v1/teams/team-1/invites").send({
      email: "second-invitee@example.com",
      role: "member"
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(
      "EasyTestData Cloud allows up to 2 members per team. Run it locally for no limits."
    );
    expect(clientReleaseMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invite acceptance when the current member cap has no available seat", async () => {
    authState.user = { id: "user-2", teamId: "team-1", role: "member" };
    getLimitsMock.mockReturnValue({ teamMembers: 2 });

    clientQueryMock.mockImplementation((sql, params) => {
      if (sql === "BEGIN" || sql === "ROLLBACK" || sql.startsWith("SELECT pg_advisory")) {
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes("FROM team_invites") && sql.includes("WHERE token = $1")) {
        return Promise.resolve({
          rows: [
            {
              id: "invite-1",
              team_id: "team-1",
              email: "invitee@example.com",
              role: "member"
            }
          ]
        });
      }

      if (sql.includes("SELECT email FROM users")) {
        expect(params).toEqual(["user-2"]);
        return Promise.resolve({ rows: [{ email: "invitee@example.com" }] });
      }

      if (sql.includes("FROM team_members") && sql.includes("user_id = $2")) {
        return Promise.resolve({ rows: [] });
      }

      if (isSeatUsageQuery(sql)) {
        expectSeatUsageExcludesExistingMemberInvites(sql);
        expect(params).toEqual(["team-1", "invite-1"]);
        return Promise.resolve({ rows: [{ member_count: 2, pending_invite_count: 0 }] });
      }

      if (sql.includes("INSERT INTO team_members")) {
        throw new Error("member cap should prevent membership insert");
      }

      if (sql.includes("UPDATE team_invites")) {
        throw new Error("failed acceptance should not consume invite");
      }

      return Promise.resolve({ rows: [] });
    });

    const app = makeApp();
    const res = await request(app)
      .post("/api/v1/teams/invites/accept")
      .send({ token: "raw-token" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(
      "EasyTestData Cloud allows up to 2 members per team. Run it locally for no limits."
    );
    expect(clientReleaseMock).toHaveBeenCalledTimes(1);
  });

  it("allows an accepted invite to convert its reserved seat into a membership", async () => {
    authState.user = { id: "user-2", teamId: "team-1", role: "member" };
    getLimitsMock.mockReturnValue({ teamMembers: 2 });

    clientQueryMock.mockImplementation((sql, params) => {
      if (sql.includes("INSERT INTO refresh_tokens"))
        return Promise.resolve({ rows: [], rowCount: 1 });
      if (sql.includes("SELECT session_version FROM users"))
        return Promise.resolve({ rows: [{ session_version: 0 }] });
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql.startsWith("SELECT pg_advisory") ||
        sql.includes("INSERT INTO team_members") ||
        sql.includes("UPDATE team_invites")
      ) {
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes("FROM team_invites") && sql.includes("WHERE token = $1")) {
        return Promise.resolve({
          rows: [
            {
              id: "invite-1",
              team_id: "team-1",
              email: "invitee@example.com",
              role: "member"
            }
          ]
        });
      }

      if (sql.includes("SELECT email FROM users")) {
        expect(params).toEqual(["user-2"]);
        return Promise.resolve({ rows: [{ email: "invitee@example.com" }] });
      }

      if (sql.includes("SELECT * FROM users WHERE id = $1")) {
        return Promise.resolve({
          rows: [{ id: "user-2", email: "invitee@example.com", display_name: "Invitee" }]
        });
      }

      if (sql === "SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2") {
        return Promise.resolve({ rows: [{ role: "member" }] });
      }

      if (sql.includes("FROM team_members") && sql.includes("user_id = $2")) {
        return Promise.resolve({ rows: [] });
      }

      if (isSeatUsageQuery(sql)) {
        expectSeatUsageExcludesExistingMemberInvites(sql);
        expect(params).toEqual(["team-1", "invite-1"]);
        return Promise.resolve({ rows: [{ member_count: 1, pending_invite_count: 0 }] });
      }

      return Promise.resolve({ rows: [] });
    });

    const app = makeApp();
    const res = await request(app)
      .post("/api/v1/teams/invites/accept")
      .send({ token: "raw-token" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: true, teamId: "team-1", role: "member" });
    // The team's invite lock comes before the invite row lock (the order re-inviting takes).
    const acceptSql = clientQueryMock.mock.calls.map(([sql]) => sql);
    expect(acceptSql.findIndex((sql) => sql.includes("pg_advisory_xact_lock"))).toBeLessThan(
      acceptSql.findIndex((sql) => sql.includes("FROM team_invites") && sql.includes("FOR UPDATE"))
    );
    // Accepting switches the invitee into the new team with fresh tokens.
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
    expect(clientQueryMock).toHaveBeenCalledWith(
      "UPDATE users SET active_team_id = $2 WHERE id = $1",
      ["user-2", "team-1"]
    );
    expect(clientQueryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO team_members"),
      ["team-1", "user-2", "member"]
    );
    expect(clientQueryMock).toHaveBeenCalledWith(
      "UPDATE team_invites SET accepted_at = NOW() WHERE id = $1",
      ["invite-1"]
    );
    expect(clientReleaseMock).toHaveBeenCalledTimes(1);
  });
});

describe("invite acceptance keeps the token out of the URL", () => {
  beforeEach(() => {
    authState.user = { id: "user-2", teamId: "team-1", role: "member" };
    clientQueryMock.mockReset();
    clientQueryMock.mockResolvedValue({ rows: [] });
  });

  it("looks the invite up by the hash of the token in the body", async () => {
    const res = await request(makeApp())
      .post("/api/v1/teams/invites/accept")
      .send({ token: "raw-token" });

    expect(res.status).toBe(404);
    const lookup = clientQueryMock.mock.calls.find(([sql]) => sql.includes("WHERE token = $1"));
    expect(lookup[1]).toEqual([crypto.createHash("sha256").update("raw-token").digest("hex")]);
  });

  it("answers 400 without a token", async () => {
    const res = await request(makeApp()).post("/api/v1/teams/invites/accept").send({});
    expect(res.status).toBe(400);
    expect(clientQueryMock).not.toHaveBeenCalled();
  });

  it("does not accept the token in the path", async () => {
    const res = await request(makeApp()).post("/api/v1/teams/invites/raw-token/accept");
    expect(res.status).toBe(404);
    expect(clientQueryMock).not.toHaveBeenCalled();
  });
});

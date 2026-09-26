import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn()
}));

vi.mock("../src/db/pool.js", async () => {
  const { fakeTransaction } = await import("./fake-transaction.js");
  return {
    query: (...args) => mocks.query(...args),
    ...fakeTransaction(() => ({ query: (...args) => mocks.clientQuery(...args) }))
  };
});

vi.mock("../src/auth/passport-setup.js", () => ({ setupPassportStrategies: () => {} }));

vi.mock("../src/services/limits.js", () => ({
  getLimits: () => ({ teamMembers: -1, loadsPerMonth: -1 }),
  limitExceededError: (kind) => Object.assign(new Error(`${kind} limit`), { statusCode: 403 })
}));

import { config } from "../src/config.js";
import { authenticate, requireTeamManager } from "../src/middleware/auth.js";
import { verifyAccessToken } from "../src/auth/tokens.js";
import { authRoutes } from "../src/routes/auth.js";
import { teamRoutes } from "../src/routes/teams.js";
import { applyAdminBootstrap, bootstrapAdminsAtStartup } from "../src/services/admin-bootstrap.js";
import { oauthCodes } from "../src/state/memory.js";
import { signTestToken } from "./utils.js";

const A_TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B_TEAM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function userRow(memberships) {
  return { id: "user-b", suspended_at: null, is_admin: false, memberships };
}

function sqlCalls() {
  return mocks.query.mock.calls.map(([sql]) => sql);
}

function bearer(overrides = {}) {
  return `Bearer ${signTestToken({ sub: "user-b", teamId: A_TEAM, role: "owner", ...overrides })}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  oauthCodes.clear();
});

describe("authenticate resolves team membership from the database", () => {
  function makeApp() {
    const app = express();
    app.get("/api/v1/jobs", authenticate, (req, res) => res.json(req.user));
    app.post("/api/v1/manage", authenticate, requireTeamManager, (_req, res) =>
      res.json({ ok: true })
    );
    return app;
  }

  it("returns 401 once the membership for the token's team is gone", async () => {
    mocks.query.mockResolvedValue({ rows: [userRow({ [B_TEAM]: "owner" })] });
    const res = await request(makeApp()).get("/api/v1/jobs").set("Authorization", bearer());
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TEAM_MEMBERSHIP_REVOKED");
  });

  it("takes the role from the database, not the token", async () => {
    mocks.query.mockResolvedValue({ rows: [userRow({ [A_TEAM]: "member" })] });
    const app = makeApp();
    const res = await request(app).get("/api/v1/jobs").set("Authorization", bearer());
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("member");

    // ...so a token claiming "owner" cannot pass an owner/admin gate.
    const gated = await request(app).post("/api/v1/manage").set("Authorization", bearer());
    expect(gated.status).toBe(403);
  });
});

describe("team switching and session team resolution", () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/v1/auth", authRoutes());
    return app;
  }

  it("switch-team refuses teams the user does not belong to", async () => {
    mocks.query.mockImplementation(async (sql) => {
      if (sql.includes("memberships")) return { rows: [userRow({ [A_TEAM]: "owner" })] };
      return { rows: [] };
    });
    const res = await request(makeApp())
      .post("/api/v1/auth/switch-team")
      .set("Authorization", bearer())
      .send({ teamId: B_TEAM });
    expect(res.status).toBe(403);
    expect(sqlCalls().some((sql) => sql.includes("active_team_id"))).toBe(false);
  });

  it("switch-team sets the active team and returns tokens for it", async () => {
    // Issuance runs in its own transaction on a pool client: same stub.
    mocks.clientQuery.mockImplementation((...args) => mocks.query(...args));
    mocks.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO refresh_tokens")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT session_version FROM users"))
        return { rows: [{ session_version: 0 }] };
      if (sql.includes("memberships")) {
        return { rows: [userRow({ [A_TEAM]: "owner", [B_TEAM]: "member" })] };
      }
      if (sql.includes("SELECT role FROM team_members")) return { rows: [{ role: "member" }] };
      if (sql.includes("SELECT * FROM users")) {
        return { rows: [{ id: "user-b", email: "b@x.com", display_name: "B" }] };
      }
      return { rows: [] };
    });
    const res = await request(makeApp())
      .post("/api/v1/auth/switch-team")
      .set("Authorization", bearer())
      .send({ teamId: B_TEAM });
    expect(res.status).toBe(200);
    expect(res.body.teamId).toBe(B_TEAM);
    expect(res.body.role).toBe("member");
    expect(verifyAccessToken(res.body.accessToken).teamId).toBe(B_TEAM);
    expect(mocks.query).toHaveBeenCalledWith("UPDATE users SET active_team_id = $2 WHERE id = $1", [
      "user-b",
      B_TEAM
    ]);
  });

  it("sign-in issues a token for the active team while the user is still a member", async () => {
    mocks.clientQuery.mockImplementation((...args) => mocks.query(...args));
    mocks.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO refresh_tokens")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT session_version FROM users"))
        return { rows: [{ session_version: 0 }] };
      if (sql.includes("SELECT * FROM users WHERE id")) {
        return {
          rows: [
            {
              id: "user-b",
              email: "b@x.com",
              oauth_provider: "github",
              oauth_provider_id: "gh-b",
              session_version: 0
            }
          ]
        };
      }
      if (sql.includes("tm.team_id = u.active_team_id")) {
        return { rows: [{ team_id: A_TEAM, role: "member" }] };
      }
      return { rows: [] };
    });
    oauthCodes.set(
      "abc",
      { userId: "user-b", sessionVersion: 0, provider: "github", providerId: "gh-b" },
      60_000
    );
    const res = await request(makeApp()).post("/api/v1/auth/oauth/exchange").send({ code: "abc" });
    expect(res.status).toBe(200);
    expect(res.body.teamId).toBe(A_TEAM);
    expect(verifyAccessToken(res.body.accessToken).role).toBe("member");
  });

  it("refresh falls back to the user's own team once the active membership is gone", async () => {
    mocks.clientQuery.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO refresh_tokens")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT user_id FROM refresh_tokens"))
        return { rows: [{ user_id: "user-b" }] };
      if (sql.includes("UPDATE refresh_tokens SET used_at"))
        return { rows: [{ user_id: "user-b", session_version: 0 }] };
      if (sql.includes("SELECT email, display_name, suspended_at")) {
        return {
          rows: [{ email: "b@x.com", display_name: "B", suspended_at: null, session_version: 0 }]
        };
      }
      if (sql.includes("SELECT session_version FROM users"))
        return { rows: [{ session_version: 0 }] };
      if (sql.includes("tm.team_id = u.active_team_id")) return { rows: [] };
      if (sql.includes("ORDER BY CASE tm.role"))
        return { rows: [{ team_id: B_TEAM, role: "owner" }] };
      return { rows: [] };
    });
    const res = await request(makeApp())
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: "valid-refresh-token" });
    expect(res.status).toBe(200);
    expect(verifyAccessToken(res.body.accessToken).teamId).toBe(B_TEAM);
    expect(mocks.clientQuery).toHaveBeenCalledWith(
      "UPDATE users SET active_team_id = $2 WHERE id = $1",
      ["user-b", B_TEAM]
    );
  });
});

describe("team invites and membership management", () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/v1/teams", teamRoutes());
    return app;
  }

  function mockTeamDb({ actorRole = "owner", targetRole = "member" } = {}) {
    mocks.query.mockImplementation(async (sql, params) => {
      if (sql.includes("memberships")) return { rows: [userRow({ [A_TEAM]: actorRole })] };
      if (sql.includes("SELECT * FROM team_members WHERE team_id = $1 AND user_id = $2")) {
        const role = params[1] === "user-b" ? actorRole : targetRole;
        return { rows: role ? [{ team_id: A_TEAM, user_id: params[1], role }] : [] };
      }
      if (sql.includes("SELECT name FROM teams")) return { rows: [{ name: "Team A" }] };
      return { rows: [] };
    });
    mocks.clientQuery.mockImplementation(async (sql) => {
      if (sql.includes("AS member_count")) {
        return { rows: [{ member_count: 1, pending_invite_count: 0 }] };
      }
      if (sql.includes("INSERT INTO team_invites")) {
        return { rows: [{ id: "inv-1", email: "c@x.com", role: "member" }] };
      }
      return { rows: [] };
    });
  }

  it("always returns a shareable inviteUrl (nothing sends email)", async () => {
    mockTeamDb();
    const res = await request(makeApp())
      .post(`/api/v1/teams/${A_TEAM}/invites`)
      .set("Authorization", bearer())
      .send({ email: "c@x.com" });
    expect(res.status).toBe(201);
    expect(res.body.inviteUrl).toMatch(
      new RegExp(`^${config.appUrl}/invite\\?token=[0-9a-f]{48}$`)
    );
  });

  it("lets an owner remove a member, whose next request for that team is refused", async () => {
    mockTeamDb({ actorRole: "owner", targetRole: "member" });
    const members = new Map([
      ["user-b", "owner"],
      ["user-c", "member"]
    ]);
    const teamDbQuery = mocks.query.getMockImplementation();
    mocks.query.mockImplementation(async (sql, params) => {
      if (sql.includes("memberships")) {
        const role = members.get(params[0]);
        return { rows: [{ ...userRow(role ? { [A_TEAM]: role } : {}), id: params[0] }] };
      }
      if (sql.includes("DELETE FROM team_members")) {
        members.delete(params[1]);
        return { rows: [], rowCount: 1 };
      }
      return teamDbQuery(sql, params);
    });
    const app = makeApp();
    app.get("/api/v1/jobs", authenticate, (_req, res) => res.json({ ok: true }));
    const memberToken = `Bearer ${signTestToken({ sub: "user-c", teamId: A_TEAM, role: "member" })}`;
    expect((await request(app).get("/api/v1/jobs").set("Authorization", memberToken)).status).toBe(
      200
    );

    const res = await request(app)
      .delete(`/api/v1/teams/${A_TEAM}/members/user-c`)
      .set("Authorization", bearer());
    expect(res.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(
      "DELETE FROM team_members WHERE team_id = $1 AND user_id = $2",
      [A_TEAM, "user-c"]
    );

    const next = await request(app).get("/api/v1/jobs").set("Authorization", memberToken);
    expect(next.status).toBe(401);
    expect(next.body.code).toBe("TEAM_MEMBERSHIP_REVOKED");
  });

  it("refuses removals by plain members and removal of the owner", async () => {
    mockTeamDb({ actorRole: "member", targetRole: "member" });
    const byMember = await request(makeApp())
      .delete(`/api/v1/teams/${A_TEAM}/members/user-c`)
      .set("Authorization", bearer());
    expect(byMember.status).toBe(403);

    mockTeamDb({ actorRole: "admin", targetRole: "owner" });
    const owner = await request(makeApp())
      .delete(`/api/v1/teams/${A_TEAM}/members/user-c`)
      .set("Authorization", bearer());
    expect(owner.status).toBe(400);
  });

  it("lets a member leave the team", async () => {
    mockTeamDb({ actorRole: "member" });
    const res = await request(makeApp())
      .delete(`/api/v1/teams/${A_TEAM}/members/user-b`)
      .set("Authorization", bearer());
    expect(res.status).toBe(200);
  });
});

describe("admin bootstrap", () => {
  const original = { emails: config.adminEmails };

  afterEach(() => {
    config.adminEmails = original.emails;
  });

  it("makes ADMIN_EMAILS users admins (case-insensitive)", async () => {
    config.adminEmails = ["boss@x.com"];
    mocks.query.mockResolvedValue({ rows: [] });
    expect(await applyAdminBootstrap({ id: "u1", email: "Boss@X.com" })).toBe(true);
    expect(sqlCalls().some((sql) => sql.includes("SET is_admin = true"))).toBe(true);
  });

  it("does not grant admin to an email that is not listed", async () => {
    config.adminEmails = ["boss@x.com"];
    expect(await applyAdminBootstrap({ id: "u1", email: "someone@x.com" })).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("applies ADMIN_EMAILS to existing users at startup", async () => {
    config.adminEmails = ["boss@x.com"];
    mocks.query.mockImplementation(async (sql) =>
      sql.includes("FROM users") && sql.includes("ANY")
        ? { rows: [{ id: "u9", email: "boss@x.com" }] }
        : { rows: [] }
    );
    expect(await bootstrapAdminsAtStartup()).toBe(1);
  });
});

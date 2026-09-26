import vm from "node:vm";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { oauthStates } from "../src/state/memory.js";
import { cookiePair } from "./utils.js";

const { dbQueryMock, ensureAccessTokenMock, decryptMock } = vi.hoisted(() => ({
  dbQueryMock: vi.fn(),
  ensureAccessTokenMock: vi.fn(),
  decryptMock: vi.fn()
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireTeamManager: (req, res, next) =>
    ["owner", "admin"].includes(req.user?.role)
      ? next()
      : res.status(403).json({ error: "Insufficient permissions" }),
  authenticate: (req, _res, next) => {
    req.user = { id: "u1", teamId: "team-1", role: "owner" };
    next();
  }
}));

// Transactions run their statements through the same mock (as a client), in order.
vi.mock("../src/db/pool.js", async () => {
  const { fakeTransaction } = await import("./fake-transaction.js");
  const { transaction, rollback } = fakeTransaction(() => ({
    query: (...a) => dbQueryMock(...a)
  }));
  return { query: (...a) => dbQueryMock(...a), transaction, rollback };
});
vi.mock("../src/workers/runner.js", () => ({ notifyJobQueued: vi.fn() }));
// Keep expected warnings (rejected states, failed lookups) out of the test output.
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));
vi.mock("@easytestdata/qbo-client", () => ({
  QboClient: vi.fn(() => ({ ensureAccessToken: (...a) => ensureAccessTokenMock(...a) })),
  loadPlanIntoQbo: vi.fn(),
  purgeTransactions: vi.fn(),
  rollbackLoad: vi.fn()
}));
vi.mock("../src/crypto/tokens.js", () => ({
  decryptTokenPair: (...a) => decryptMock(...a),
  encryptTokenPair: () => ({ access_token_enc: "e", refresh_token_enc: "e2", token_iv: "iv" })
}));

import { connectionRoutes } from "../src/routes/connections.js";
import { acquireConnectionLock, releaseConnectionLock } from "../src/services/connection-lock.js";

// Intuit app keys come from the environment (Cloud mode in tests).
vi.stubEnv("QBO_CLIENT_ID", "client-123");
vi.stubEnv("QBO_CLIENT_SECRET", "secret-123");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/connections", connectionRoutes());
  app.use((err, _req, res, _next) =>
    res.status(err.status || err.statusCode || 500).json({ error: err.message })
  );
  return app;
}

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
const connRow = (over) => ({
  id: "c1",
  connected_at: daysAgo(1),
  last_used_at: daysAgo(1),
  access_token_enc: "enc-a",
  refresh_token_enc: "enc-r",
  token_iv: "iv",
  ...over
});

describe("GET /connections/:id/health (passive, age-based)", () => {
  // Another operation holds the connection's lock throughout: a passive health check never
  // needs it, so it answers anyway.
  let heldLock;
  beforeEach(async () => {
    heldLock = await acquireConnectionLock("c1");
  });
  afterEach(async () => {
    await releaseConnectionLock(heldLock);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    decryptMock.mockReturnValue({ accessToken: "a", refreshToken: "r" });
  });

  it("reports healthy for a recently-used connection without locking or refreshing", async () => {
    dbQueryMock.mockResolvedValue({ rows: [connRow()] });

    const res = await request(makeApp()).get("/api/connections/c1/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("healthy");
    // Passive: it answered while the lock was held, and triggered no token refresh.
    expect(ensureAccessTokenMock).not.toHaveBeenCalled();
  });

  it("reports expired from age alone when inactive beyond the expiry window", async () => {
    dbQueryMock.mockResolvedValue({
      rows: [connRow({ connected_at: daysAgo(200), last_used_at: daysAgo(120) })]
    });

    const res = await request(makeApp()).get("/api/connections/c1/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("expired");
  });

  it("warns as the connection approaches the expiry window", async () => {
    dbQueryMock.mockResolvedValue({
      rows: [connRow({ connected_at: daysAgo(90), last_used_at: daysAgo(85) })]
    });

    const res = await request(makeApp()).get("/api/connections/c1/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("warning");
    expect(res.body.warnings.length).toBeGreaterThan(0);
  });

  it("reports expired when the stored token is unreadable (still no lock/refresh)", async () => {
    dbQueryMock.mockResolvedValue({ rows: [connRow()] });
    decryptMock.mockImplementation(() => {
      throw new Error("bad decrypt / key mismatch");
    });

    const res = await request(makeApp()).get("/api/connections/c1/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("expired");
    expect(res.body.warnings[0]).toMatch(/reconnect/i);
    // Local readability check only — no lock, no refresh.
    expect(ensureAccessTokenMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the connection is not found", async () => {
    dbQueryMock.mockResolvedValue({ rows: [] });

    const res = await request(makeApp()).get("/api/connections/c1/health");

    expect(res.status).toBe(404);
  });
});

/** Starts a QBO connect as the current user; returns the signed state and its browser cookie. */
/**
 * Runs the inline script of a callback page answered without a usable state in a fake browser
 * window: `opener` is the window that opened it (null for a normal tab), `openerOrigin` that
 * window's origin (reading it throws for a cross-origin opener, as in a browser).
 */
function runCallbackPage(html, { opener = false, openerOrigin = "http://app.test" } = {}) {
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  const events = { messages: [], closed: false, replacedWith: null };
  const openerWindow = opener
    ? {
        get location() {
          if (openerOrigin !== "http://app.test") throw new Error("SecurityError");
          return { origin: openerOrigin };
        },
        postMessage: (data, targetOrigin) => events.messages.push({ data, targetOrigin })
      }
    : null;
  const location = {
    origin: "http://app.test",
    replace: (url) => (events.replacedWith = url)
  };
  const window = { opener: openerWindow, close: () => (events.closed = true), location };
  vm.runInNewContext(script, { window, location });
  return events;
}

async function startConnect(mode) {
  const original = { id: config.qbo.clientId, secret: config.qbo.clientSecret };
  vi.stubEnv("QBO_CLIENT_ID", "client-123");
  vi.stubEnv("QBO_CLIENT_SECRET", "secret-123");
  dbQueryMock.mockResolvedValue({ rows: [{ count: 0 }] });
  try {
    const res = await request(makeApp())
      .get("/api/connections/authorize")
      .query(mode ? { mode } : {});
    expect(res.status).toBe(200);
    return {
      state: new URL(res.body.url).searchParams.get("state"),
      cookie: cookiePair(res, "eztd_qbo_connect")
    };
  } finally {
    vi.stubEnv("QBO_CLIENT_ID", original.id);
    vi.stubEnv("QBO_CLIENT_SECRET", original.secret);
    dbQueryMock.mockReset();
  }
}

describe("connection list, delete and QBO callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbQueryMock.mockReset();
    oauthStates.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists connection metadata with its token health", async () => {
    dbQueryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "connection-1",
          realm_id: "realm-1",
          company_name: "Sandbox Co",
          base_url: "https://sandbox-quickbooks.api.intuit.com",
          connected_at: new Date().toISOString(),
          last_used_at: new Date().toISOString()
        }
      ]
    });

    const res = await request(makeApp()).get("/api/connections");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: "connection-1",
      realm_id: "realm-1",
      company_name: "Sandbox Co",
      tokenHealth: "ok"
    });
  });

  it("lists whether each connection already holds an earlier load (not from the job list)", async () => {
    dbQueryMock.mockResolvedValueOnce({
      rows: [
        { id: "c-old", connected_at: daysAgo(1), last_used_at: null, has_prior_load: true },
        { id: "c-new", connected_at: daysAgo(1), last_used_at: null, has_prior_load: false }
      ]
    });

    const res = await request(makeApp()).get("/api/connections");

    expect(res.body.map((c) => [c.id, c.has_prior_load])).toEqual([
      ["c-old", true],
      ["c-new", false]
    ]);
    const [sql, params] = dbQueryMock.mock.calls[0];
    expect(params).toEqual(["team-1"]);
    // Computed per connection over every completed (or orphaned) load, with no row limit.
    expect(sql).toMatch(/EXISTS\s*\(/);
    expect(sql).toContain("j.connection_id = c.id");
    expect(sql).toContain("j.type = 'load'");
    expect(sql).toContain("'completed', 'failed_with_orphans'");
    expect(sql).not.toMatch(/LIMIT/i);
  });

  // services/connection-guard.js: team row, then connection row, then the check and the write.
  function disconnectable({ activeJob = false } = {}) {
    dbQueryMock.mockImplementation(async (sql) => {
      if (sql.includes("FROM qbo_connections WHERE id = $1 AND team_id = $2 FOR NO KEY UPDATE")) {
        return { rows: [{ id: "connection-1", disconnected_at: null }] };
      }
      if (sql.includes("FROM jobs")) return { rows: activeJob ? [{ 1: 1 }] : [] };
      return { rows: [], rowCount: 1 };
    });
  }
  const statements = () => dbQueryMock.mock.calls.map(([sql]) => sql.trim().split(/\s+/)[0]);

  it("lets an owner disconnect a connection with no active job, keeping the row", async () => {
    disconnectable();

    const res = await request(makeApp()).delete("/api/connections/connection-1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(statements()).toEqual(["BEGIN", "SELECT", "SELECT", "SELECT", "UPDATE", "COMMIT"]);
    const calls = dbQueryMock.mock.calls;
    expect(calls[1]).toEqual([
      expect.stringMatching(/FROM teams .* FOR NO KEY UPDATE/),
      ["team-1"]
    ]);
    expect(calls[2][1]).toEqual(["connection-1", "team-1"]);
    expect(calls[3][0]).toContain("('pending', 'running', 'cancelling')");
    const [sql, params] = calls[4];
    expect(sql).toMatch(/^UPDATE qbo_connections/);
    expect(sql).toContain("access_token_enc = NULL");
    expect(sql).toContain("disconnected_at = NOW()");
    expect(params).toEqual(["connection-1"]);
  });

  it("refuses (409) to delete a connection an active job uses", async () => {
    disconnectable({ activeJob: true });

    const res = await request(makeApp()).delete("/api/connections/connection-1");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/job/i);
    expect(statements()).not.toContain("UPDATE");
  });

  it("refuses (409) to delete a connection whose lock is held, without touching the row", async () => {
    const held = await acquireConnectionLock("connection-1");
    try {
      dbQueryMock.mockResolvedValue({ rows: [{ id: "connection-1" }] });

      const res = await request(makeApp()).delete("/api/connections/connection-1");

      expect(res.status).toBe(409);
      expect(dbQueryMock).not.toHaveBeenCalled();
    } finally {
      await releaseConnectionLock(held);
    }
  });

  it("answers deleted for a connection that does not exist (idempotent)", async () => {
    dbQueryMock.mockResolvedValue({ rows: [] });

    const res = await request(makeApp()).delete("/api/connections/connection-1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
  });

  it("passes abort signals to QBO OAuth callback fetches", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "access-token",
          refresh_token: "refresh-token"
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ CompanyInfo: { CompanyName: "Sandbox Co" } })
      });
    vi.stubGlobal("fetch", fetchMock);

    const { state, cookie } = await startConnect();
    dbQueryMock.mockResolvedValue({ rows: [{ id: "connection-1" }] });

    const res = await request(makeApp())
      .get("/api/connections/callback")
      .set("Cookie", cookie)
      .query({ code: "oauth-code", realmId: "realm-1", state });

    expect(res.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("still connects when the company-info lookup fails after token exchange", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "access-token",
          refresh_token: "refresh-token"
        })
      })
      // Company-info times out / aborts — must not discard the exchanged tokens.
      .mockRejectedValueOnce(new Error("The operation was aborted due to timeout"));
    vi.stubGlobal("fetch", fetchMock);

    const { state, cookie } = await startConnect();
    dbQueryMock.mockResolvedValue({ rows: [{ id: "connection-1" }] });

    const res = await request(makeApp())
      .get("/api/connections/callback")
      .set("Cookie", cookie)
      .query({ code: "oauth-code", realmId: "realm-1", state });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("connected=true");
    expect(res.headers.location).not.toContain("error");
    // Tokens were still persisted despite the company-info failure.
    expect(dbQueryMock).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE qbo_connections"),
      expect.any(Array)
    );
  });
});

describe("connection limit (Cloud: 3 per team)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbQueryMock.mockReset();
    oauthStates.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "a", refresh_token: "r" })
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A team that already has three connections; `existingRealm` is one of them. */
  function teamAtLimit({ existingRealm }) {
    dbQueryMock.mockImplementation(async (sql, params) => {
      if (sql.includes("FROM team_members")) return { rows: [{ 1: 1 }] };
      if (
        sql.includes("FROM qbo_connections WHERE team_id = $1 AND realm_id = $2 FOR NO KEY UPDATE")
      ) {
        return {
          rows: params.includes(existingRealm) ? [{ id: "c1", disconnected_at: null }] : []
        };
      }
      if (sql.startsWith("UPDATE qbo_connections")) return { rows: [], rowCount: 1 };
      if (sql.includes("COUNT(*)")) return { rows: [{ count: 3 }] };
      if (sql.startsWith("INSERT INTO qbo_connections")) return { rows: [{ id: "c4" }] };
      return { rows: [] };
    });
  }

  const statements = () => dbQueryMock.mock.calls.map(([sql]) => sql.trim().split(/\s+/)[0]);

  it("starts the connect flow at the limit (the realm is only known at the callback)", async () => {
    const res = await request(makeApp()).get("/api/connections/authorize");
    expect(res.status).toBe(200);
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it("reconnects an existing sandbox at the limit", async () => {
    const { state, cookie } = await startConnect();
    teamAtLimit({ existingRealm: "realm-1" });

    const res = await request(makeApp())
      .get("/api/connections/callback")
      .set("Cookie", cookie)
      .query({ code: "c", realmId: "realm-1", state });

    expect(res.headers.location).toBe("/home?connected=true");
    expect(dbQueryMock.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
  });

  it("refuses a new sandbox at the limit", async () => {
    const { state, cookie } = await startConnect();
    teamAtLimit({ existingRealm: "realm-1" });

    const res = await request(makeApp())
      .get("/api/connections/callback")
      .set("Cookie", cookie)
      .query({ code: "c", realmId: "realm-new", state });

    expect(res.headers.location).toBe("/home?error=connection_limit_reached");
    expect(dbQueryMock.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
  });

  it("counts and inserts a new sandbox under the team row lock, in one transaction", async () => {
    const { state, cookie } = await startConnect();
    teamAtLimit({ existingRealm: "realm-1" });
    const base = dbQueryMock.getMockImplementation();
    dbQueryMock.mockImplementation(async (sql, params) =>
      sql.includes("COUNT(*)") ? { rows: [{ count: 2 }] } : base(sql, params)
    );

    const res = await request(makeApp())
      .get("/api/connections/callback")
      .set("Cookie", cookie)
      .query({ code: "c", realmId: "realm-new", state });

    expect(res.headers.location).toBe("/home?connected=true");
    const lockCall = dbQueryMock.mock.calls.find(([sql]) => sql.includes("FOR NO KEY UPDATE"));
    expect(lockCall[0]).toMatch(/FROM teams WHERE id = \$1 FOR NO KEY UPDATE/);
    expect(lockCall[1]).toEqual(["team-1"]);
    const order = statements();
    const begin = order.indexOf("BEGIN");
    // team lock, connection lock, membership (FOR SHARE), count, insert
    expect(order.slice(begin)).toEqual([
      "BEGIN",
      "SELECT",
      "SELECT",
      "SELECT",
      "SELECT",
      "INSERT",
      "COMMIT"
    ]);
    expect(dbQueryMock.mock.calls[begin + 3][0]).toMatch(/FROM team_members[\s\S]*FOR SHARE/);
  });
});

describe("GET /connections/authorize QBO configuration", () => {
  const original = { id: config.qbo.clientId, secret: config.qbo.clientSecret };

  beforeEach(() => {
    vi.clearAllMocks();
    dbQueryMock.mockReset();
    oauthStates.clear();
  });

  afterEach(() => {
    vi.stubEnv("QBO_CLIENT_ID", original.id);
    vi.stubEnv("QBO_CLIENT_SECRET", original.secret);
  });

  it("returns a clear 503 instead of redirecting to Intuit when QBO keys are unset", async () => {
    vi.stubEnv("QBO_CLIENT_ID", "");
    vi.stubEnv("QBO_CLIENT_SECRET", "");

    const res = await request(makeApp()).get("/api/connections/authorize");

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("QBO_CLIENT_ID");
    expect(res.body.error).toContain(config.qbo.redirectUri);
    expect(res.body).not.toHaveProperty("url");
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it("returns the Intuit authorize URL with the configured redirect URI when keys are set", async () => {
    vi.stubEnv("QBO_CLIENT_ID", "client-123");
    vi.stubEnv("QBO_CLIENT_SECRET", "secret-123");
    dbQueryMock.mockResolvedValue({ rows: [{ count: 0 }] });

    const res = await request(makeApp()).get("/api/connections/authorize");

    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(config.qbo.redirectUri);
  });
});

describe("QBO connect OAuth state binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbQueryMock.mockReset();
    oauthStates.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "a", refresh_token: "r" })
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sets an httpOnly SameSite=Lax nonce cookie scoped to the connections path", async () => {
    const original = { id: config.qbo.clientId, secret: config.qbo.clientSecret };
    vi.stubEnv("QBO_CLIENT_ID", "client-123");
    vi.stubEnv("QBO_CLIENT_SECRET", "secret-123");
    dbQueryMock.mockResolvedValue({ rows: [{ count: 0 }] });
    const res = await request(makeApp()).get("/api/connections/authorize");
    vi.stubEnv("QBO_CLIENT_ID", original.id);
    vi.stubEnv("QBO_CLIENT_SECRET", original.secret);
    const header = res.headers["set-cookie"].find((c) => c.startsWith("eztd_qbo_connect="));
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/api/v1/connections");
  });

  it("rejects a callback from a browser that did not start the flow (no cookie)", async () => {
    const { state } = await startConnect();
    const res = await request(makeApp())
      .get("/api/connections/callback")
      .query({ code: "c", realmId: "realm-1", state });
    expect(res.status).toBe(200);
    expect(runCallbackPage(res.text).replacedWith).toBe("/home?error=state_invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a replayed state even with the right cookie", async () => {
    const { state, cookie } = await startConnect();
    dbQueryMock.mockResolvedValue({ rows: [{ id: "connection-1" }] });
    const first = await request(makeApp())
      .get("/api/connections/callback")
      .set("Cookie", cookie)
      .query({ code: "c", realmId: "realm-1", state });
    expect(first.headers.location).toContain("connected=true");

    const replay = await request(makeApp())
      .get("/api/connections/callback")
      .set("Cookie", cookie)
      .query({ code: "c", realmId: "realm-1", state });
    expect(runCallbackPage(replay.text).replacedWith).toBe("/home?error=state_invalid");
  });

  it("sends the browser home with qbo_not_configured when the keys are gone at callback", async () => {
    const { state, cookie } = await startConnect();
    vi.stubEnv("QBO_CLIENT_ID", "");
    dbQueryMock.mockResolvedValue({ rows: [{ 1: 1 }] });
    try {
      const res = await request(makeApp())
        .get("/api/connections/callback")
        .set("Cookie", cookie)
        .query({ code: "c", realmId: "realm-1", state });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/home?error=qbo_not_configured");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.stubEnv("QBO_CLIENT_ID", "client-123");
    }
  });

  it("answers a popup callback without keys through the popup message", async () => {
    const { state, cookie } = await startConnect("popup");
    vi.stubEnv("QBO_CLIENT_ID", "");
    dbQueryMock.mockResolvedValue({ rows: [{ 1: 1 }] });
    try {
      const res = await request(makeApp())
        .get("/api/connections/callback")
        .set("Cookie", cookie)
        .query({ code: "c", realmId: "realm-1", state });
      expect(res.status).toBe(200);
      expect(res.text).toContain('{"error":"qbo_not_configured"}');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.stubEnv("QBO_CLIENT_ID", "client-123");
    }
  });

  it("answers a connect the user declined at Intuit (redirect), using up the state", async () => {
    const { state, cookie } = await startConnect();
    const res = await request(makeApp())
      .get("/api/connections/callback")
      .set("Cookie", cookie)
      .query({ error: "access_denied", state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/home?error=connect_cancelled");
    expect(fetch).not.toHaveBeenCalled();
    const cleared = res.headers["set-cookie"].find((c) => c.startsWith("eztd_qbo_connect="));
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    const replay = await request(makeApp())
      .get("/api/connections/callback")
      .set("Cookie", cookie)
      .query({ code: "c", realmId: "realm-1", state });
    expect(runCallbackPage(replay.text).replacedWith).toBe("/home?error=state_invalid");
  });

  it("answers a declined popup connect through the popup message", async () => {
    const { state, cookie } = await startConnect("popup");
    const res = await request(makeApp())
      .get("/api/connections/callback")
      .set("Cookie", cookie)
      .query({ error: "access_denied", state });
    expect(res.status).toBe(200);
    expect(res.text).toContain('{"error":"connect_cancelled"}');
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers a declined connect with no usable state by redirecting home", async () => {
    const res = await request(makeApp())
      .get("/api/connections/callback")
      .query({ error: "access_denied", state: "forged" });
    expect(runCallbackPage(res.text).replacedWith).toBe("/home?error=connect_cancelled");
  });

  it("refuses to store tokens when the state's user has left the team", async () => {
    const { state, cookie } = await startConnect();
    dbQueryMock.mockResolvedValue({ rows: [] });
    const res = await request(makeApp())
      .get("/api/connections/callback")
      .set("Cookie", cookie)
      .query({ code: "c", realmId: "realm-1", state });
    expect(res.headers.location).toBe("/home?error=not_team_member");
    // Refused early, before the token exchange; nothing is stored.
    expect(fetch).not.toHaveBeenCalled();
    expect(dbQueryMock).not.toHaveBeenCalledWith(
      expect.stringContaining("qbo_connections"),
      expect.anything()
    );
  });

  it("re-checks membership when storing: a user removed during the exchange stores nothing", async () => {
    const { state, cookie } = await startConnect();
    // Still a member at the early check, gone by the time the tokens are stored.
    let memberChecks = 0;
    dbQueryMock.mockImplementation(async (sql) =>
      sql.includes("FROM team_members") && ++memberChecks === 1
        ? { rows: [{ 1: 1 }] }
        : { rows: [] }
    );
    const res = await request(makeApp())
      .get("/api/connections/callback")
      .set("Cookie", cookie)
      .query({ code: "c", realmId: "realm-1", state });
    expect(res.headers.location).toBe("/home?error=not_team_member");
    expect(fetch).toHaveBeenCalled();
    const writes = dbQueryMock.mock.calls.filter(([sql]) =>
      /^(INSERT INTO|UPDATE) qbo_connections/.test(sql.trim())
    );
    expect(writes).toEqual([]);
    expect(dbQueryMock.mock.calls.at(-1)[0]).toBe("ROLLBACK");
  });
});

describe("QBO connect callback without a usable state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbQueryMock.mockReset();
    oauthStates.clear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tells the popup that opened it when the state expired (e.g. after a restart)", async () => {
    const { state, cookie } = await startConnect("popup");
    oauthStates.clear(); // a restart or the ten-minute expiry forgets the state
    const res = await request(makeApp())
      .get("/api/connections/callback")
      .set("Cookie", cookie)
      .query({ code: "c", realmId: "realm-1", state });

    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toMatch(/script-src 'nonce-/);
    const events = runCallbackPage(res.text, { opener: true });
    expect(events.messages).toEqual([
      { data: { error: "state_invalid" }, targetOrigin: "http://app.test" }
    ]);
    expect(events.closed).toBe(true);
    expect(events.replacedWith).toBeNull();
    // The state is still refused: nothing was exchanged or stored.
    expect(fetch).not.toHaveBeenCalled();
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it("sends a normal tab home with the error", async () => {
    const res = await request(makeApp())
      .get("/api/connections/callback")
      .query({ code: "c", realmId: "realm-1", state: "forged" });

    const events = runCallbackPage(res.text);
    expect(events.replacedWith).toBe("/home?error=state_invalid");
    expect(events.messages).toEqual([]);
    expect(events.closed).toBe(false);
    expect(res.text).toContain('href="/home?error=state_invalid"');
  });

  it("does not message or close a tab opened by another site", async () => {
    const res = await request(makeApp())
      .get("/api/connections/callback")
      .query({ code: "c", realmId: "realm-1", state: "forged" });

    const events = runCallbackPage(res.text, { opener: true, openerOrigin: "https://evil.test" });
    expect(events.messages).toEqual([]);
    expect(events.closed).toBe(false);
    expect(events.replacedWith).toBe("/home?error=state_invalid");
  });

  it("tells the popup when the user declined at Intuit and the state is gone", async () => {
    const res = await request(makeApp())
      .get("/api/connections/callback")
      .query({ error: "access_denied", state: "forged" });

    const events = runCallbackPage(res.text, { opener: true });
    expect(events.messages).toEqual([
      { data: { error: "connect_cancelled" }, targetOrigin: "http://app.test" }
    ]);
    expect(events.closed).toBe(true);
  });

  it("tells the popup when the callback carries no state at all", async () => {
    const res = await request(makeApp()).get("/api/connections/callback").query({ code: "c" });

    const events = runCallbackPage(res.text, { opener: true });
    expect(events.messages).toEqual([
      { data: { error: "callback_failed" }, targetOrigin: "http://app.test" }
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

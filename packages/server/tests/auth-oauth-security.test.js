import express from "express";
import passport from "passport";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn()
}));

vi.mock("../src/db/pool.js", async () => {
  const { fakeTransaction } = await import("./fake-transaction.js");
  return {
    query: (...args) => mocks.query(...args),
    // Transactions (the exchange, session issuance) use a client delegating to the same stub.
    ...fakeTransaction(() => ({ query: (...args) => mocks.query(...args) }))
  };
});

vi.mock("../src/middleware/auth.js", () => ({
  authenticate: (_req, res) => res.status(401).json({ error: "no" })
}));

vi.mock("../src/auth/passport-setup.js", async (importOriginal) => ({
  ...(await importOriginal()),
  setupPassportStrategies: () => {}
}));

vi.mock("../src/services/admin-bootstrap.js", () => ({
  applyAdminBootstrap: () => Promise.resolve(false)
}));

const { cookiePair } = await import("./utils.js");
const { oauthCodes, oauthStates } = await import("../src/state/memory.js");

const { authRoutes, upsertOAuthUser } = await import("../src/routes/auth.js");
const { mapGithubProfile, mapGoogleProfile, mapIntuitProfile } =
  await import("../src/auth/passport-setup.js");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/auth", authRoutes());
  return app;
}

function sqlCalls() {
  return mocks.query.mock.calls.map(([sql]) => sql);
}

describe("OAuth provider profile mapping", () => {
  it("trusts Google emails only when email_verified is asserted", () => {
    const verified = mapGoogleProfile({
      id: "g1",
      emails: [{ value: "a@x.com", verified: true }]
    });
    expect(verified).toMatchObject({ emailVerified: true, linkByEmail: true });
    const unverified = mapGoogleProfile({
      id: "g1",
      emails: [{ value: "a@x.com", verified: false }]
    });
    expect(unverified).toMatchObject({ emailVerified: false, linkByEmail: false });
  });

  it("uses only GitHub's primary+verified address and never an unverified fallback", () => {
    const profile = mapGithubProfile({
      id: 7,
      emails: [
        { value: "other@x.com", primary: false, verified: true },
        { value: "main@x.com", primary: true, verified: true }
      ]
    });
    expect(profile).toMatchObject({ email: "main@x.com", emailVerified: true, providerId: "7" });

    const unverifiedPrimary = mapGithubProfile({
      id: 7,
      emails: [
        { value: "verified-secondary@x.com", primary: false, verified: true },
        { value: "main@x.com", primary: true, verified: false }
      ]
    });
    expect(unverifiedPrimary).toMatchObject({ emailVerified: false, linkByEmail: false });
  });

  it("honours Intuit's emailVerified flag", () => {
    expect(
      mapIntuitProfile({ id: "i1", emails: [{ value: "a@x.com", verified: false }] }).linkByEmail
    ).toBe(false);
    expect(
      mapIntuitProfile({ id: "i1", emails: [{ value: "a@x.com", verified: true }] }).linkByEmail
    ).toBe(true);
  });
});

describe("upsertOAuthUser account linking", () => {
  let existing;

  beforeEach(() => {
    vi.clearAllMocks();
    existing = null;
    mocks.query.mockImplementation(async (sql, params) => {
      if (sql.includes("WHERE oauth_provider = $1")) return { rows: [] };
      if (sql.includes("SELECT * FROM users WHERE email = $1")) {
        return { rows: existing ? [existing] : [] };
      }
      if (sql.includes("RETURNING *") && sql.includes("UPDATE users")) {
        return { rows: [{ ...existing, oauth_provider: params[0] }] };
      }
      if (sql.includes("INSERT INTO users")) {
        return { rows: [{ id: "new-user", email: params[0] }] };
      }
      return { rows: [] };
    });
  });

  const google = (verified) => ({
    provider: "google",
    providerId: "g-1",
    email: "Victim@X.com",
    emailVerified: verified,
    linkByEmail: verified,
    displayName: "Victim",
    avatarUrl: null
  });

  it("refuses a Google login whose email the provider did not verify", async () => {
    existing = { id: "victim", email: "victim@x.com" };
    await expect(upsertOAuthUser(google(false))).rejects.toMatchObject({
      code: "oauth_email_unverified"
    });
    expect(sqlCalls().some((sql) => sql.includes("UPDATE users"))).toBe(false);
  });

  it("refuses to link an existing account when the provider did not verify the email", async () => {
    mocks.query.mockImplementation(async (sql) =>
      /FROM users WHERE (LOWER\()?email/.test(sql)
        ? { rows: [{ id: "existing", email: "x@y.com" }] }
        : { rows: [] }
    );
    await expect(
      upsertOAuthUser({
        provider: "github",
        providerId: "gh-1",
        email: "x@y.com",
        linkByEmail: false,
        displayName: "X"
      })
    ).rejects.toMatchObject({ code: "oauth_email_unverified" });
    expect(sqlCalls().some((sql) => /UPDATE users|INSERT INTO users/.test(sql))).toBe(false);
  });

  it("refuses to create an account for an email the provider did not verify", async () => {
    await expect(upsertOAuthUser(google(false))).rejects.toMatchObject({
      code: "oauth_email_unverified"
    });
    expect(sqlCalls().some((sql) => sql.includes("INSERT INTO users"))).toBe(false);
  });

  it("links a provider-verified email to the existing account without signing it out", async () => {
    existing = { id: "victim", email: "victim@x.com" };
    const user = await upsertOAuthUser(google(true));
    expect(user.id).toBe("victim");
    const link = mocks.query.mock.calls.find(([sql]) => sql.includes("UPDATE users"));
    expect(link[1]).toEqual(["google", "g-1", "Victim", null, "victim"]);
    expect(sqlCalls().some((sql) => sql.includes("DELETE FROM refresh_tokens"))).toBe(false);
  });

  it("creates new accounts for provider-verified emails only", async () => {
    const user = await upsertOAuthUser(google(true));
    expect(user.id).toBe("new-user");
    const insert = mocks.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO users"));
    expect(insert[1]).toEqual(["victim@x.com", "Victim", null, "google", "g-1"]);
  });
});

describe("OAuth code exchange after the account changed hands", () => {
  const victim = {
    id: "victim",
    email: "victim@x.com",
    display_name: "Victim",
    suspended_at: null,
    oauth_provider: "github",
    oauth_provider_id: "gh-1",
    session_version: 0
  };
  let user;

  beforeEach(() => {
    vi.clearAllMocks();
    oauthCodes.clear();
    user = { ...victim };
    mocks.query.mockImplementation(async (sql) => {
      if (sql.includes("SELECT * FROM users WHERE id = $1")) return { rows: [{ ...user }] };
      if (sql.includes("FROM team_members")) return { rows: [{ team_id: "t1", role: "owner" }] };
      if (sql.includes("INSERT INTO refresh_tokens")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT session_version FROM users"))
        return { rows: [{ session_version: user.session_version }] };
      return { rows: [] };
    });
  });

  async function exchange(payload) {
    oauthCodes.set("abc", payload, 60_000);
    return request(makeApp()).post("/api/v1/auth/oauth/exchange").send({ code: "abc" });
  }

  it("exchanges a code for the account exactly as it was authenticated", async () => {
    const res = await exchange({
      userId: "victim",
      sessionVersion: 0,
      provider: "github",
      providerId: "gh-1"
    });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it("refuses a code once the account was signed out everywhere", async () => {
    // The code was issued in generation 0; a sign-out everywhere (refresh-token reuse, admin
    // revoke) bumped the generation before the code was exchanged.
    user = { ...victim, session_version: 1 };
    const res = await exchange({
      userId: "victim",
      sessionVersion: 0,
      provider: "github",
      providerId: "gh-1"
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("OAuth code is invalid or expired");
    expect(res.body.accessToken).toBeUndefined();
    expect(sqlCalls().some((sql) => sql.includes("INSERT INTO refresh_tokens"))).toBe(false);
    // The code was consumed either way.
    expect(oauthCodes.get("abc")).toBeUndefined();
  });

  it("refuses a code whose OAuth link no longer matches even in the same generation", async () => {
    user = { ...victim, oauth_provider: "google", oauth_provider_id: "g-9" };
    const res = await exchange({
      userId: "victim",
      sessionVersion: 0,
      provider: "github",
      providerId: "gh-1"
    });
    expect(res.status).toBe(400);
  });

  it("refuses a code that carries no session generation", async () => {
    const res = await exchange({ userId: "victim" });
    expect(res.status).toBe(400);
    expect(sqlCalls().some((sql) => sql.includes("INSERT INTO refresh_tokens"))).toBe(false);
  });
});

describe("OAuth state in process memory", () => {
  beforeEach(() => oauthStates.clear());

  it("keeps OAuth state single-use and bound to the starting browser", async () => {
    const { beginOAuthState, consumeOAuthState } = await import("../src/auth/oauth-state.js");
    const res = { cookie: vi.fn(), clearCookie: vi.fn() };
    const opts = { type: "login", cookieName: "c", cookiePath: "/" };
    const state = await beginOAuthState({ res, ...opts });
    const nonce = res.cookie.mock.calls[0][1];
    const req = { headers: { cookie: `c=${nonce}` } };
    await expect(consumeOAuthState({ req, res, ...opts, state })).resolves.toBeTruthy();
    await expect(consumeOAuthState({ req, res, ...opts, state })).rejects.toThrow(/already used/);
    const other = await beginOAuthState({ res, ...opts });
    const stranger = { headers: { cookie: "c=someone-else" } };
    await expect(consumeOAuthState({ req: stranger, res, ...opts, state: other })).rejects.toThrow(
      /not bound/
    );
  });
});

describe("OAuth state cookie Secure flag", () => {
  const saved = { nodeEnv: config.nodeEnv, appUrl: config.appUrl };
  afterEach(() => Object.assign(config, saved));

  async function stateCookieOptions() {
    const { beginOAuthState, consumeOAuthState } = await import("../src/auth/oauth-state.js");
    const res = { cookie: vi.fn(), clearCookie: vi.fn() };
    const opts = { type: "login", cookieName: "c", cookiePath: "/" };
    const state = await beginOAuthState({ res, ...opts });
    await consumeOAuthState({ req: { headers: {} }, res, ...opts, state }).catch(() => {});
    return { set: res.cookie.mock.calls[0][2], cleared: res.clearCookie.mock.calls[0][1] };
  }

  it("follows the app URL's scheme, not NODE_ENV: local mode over http://localhost", async () => {
    // Local mode runs with NODE_ENV=production on plain http; Safari drops Secure cookies there.
    Object.assign(config, { nodeEnv: "production", appUrl: "http://localhost:28080" });
    const { set, cleared } = await stateCookieOptions();
    expect(set.secure).toBe(false);
    expect(cleared.secure).toBe(false);
  });

  it("is Secure when the app is served over https, whatever NODE_ENV is", async () => {
    Object.assign(config, { nodeEnv: "development", appUrl: "https://app.easytestdata.com" });
    const { set, cleared } = await stateCookieOptions();
    expect(set).toMatchObject({ secure: true, httpOnly: true, sameSite: "lax" });
    expect(cleared.secure).toBe(true);
  });
});

describe("login OAuth state binding", () => {
  const original = { ...config.oauth.google };
  let authenticateCalls;

  beforeEach(() => {
    vi.clearAllMocks();
    config.oauth.google.clientId = "gid";
    config.oauth.google.clientSecret = "gsecret";
    authenticateCalls = 0;
    // Minimal passport strategy: redirects to the "provider" on start and succeeds on callback.
    passport.use("google", {
      name: "google",
      authenticate(req, options) {
        authenticateCalls++;
        if (req.query.code) {
          return this.success({
            provider: "google",
            providerId: "g-1",
            email: "u@x.com",
            emailVerified: true,
            linkByEmail: true,
            displayName: "U"
          });
        }
        return this.redirect(`https://provider.example/auth?state=${options.state}`);
      }
    });
    mocks.query.mockImplementation(async (sql) => {
      if (sql.includes("WHERE oauth_provider = $1")) {
        return {
          rows: [
            {
              id: "u1",
              email: "u@x.com",
              display_name: "U",
              oauth_provider: "google",
              oauth_provider_id: "g-1",
              session_version: 4
            }
          ]
        };
      }
      if (sql.includes("FROM team_members")) return { rows: [{ team_id: "t1", role: "owner" }] };
      return { rows: [] };
    });
  });

  afterEach(() => {
    config.oauth.google.clientId = original.clientId;
    config.oauth.google.clientSecret = original.clientSecret;
  });

  it("binds the issued code to the account's session generation and OAuth link", async () => {
    const { state, cookie } = await start();
    const res = await request(makeApp())
      .get("/api/v1/auth/google/callback")
      .set("Cookie", cookie)
      .query({ code: "c", state });
    const authCode = new URL(res.headers.location, "http://x").searchParams.get("auth_code");
    expect(oauthCodes.get(authCode)).toEqual({
      userId: "u1",
      sessionVersion: 4,
      provider: "google",
      providerId: "g-1"
    });
  });

  async function start() {
    const res = await request(makeApp()).get("/api/v1/auth/google");
    expect(res.status).toBe(302);
    const state = new URL(res.headers.location).searchParams.get("state");
    const cookieHeader = res.headers["set-cookie"].find((c) => c.startsWith("eztd_oauth_login="));
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("SameSite=Lax");
    return { state, cookie: cookiePair(res, "eztd_oauth_login") };
  }

  it("completes a login when the callback carries the same browser's cookie", async () => {
    const { state, cookie } = await start();
    const res = await request(makeApp())
      .get("/api/v1/auth/google/callback")
      .set("Cookie", cookie)
      .query({ code: "c", state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/login\?auth_code=/);
  });

  it("rejects a callback whose state was started in another browser (login CSRF)", async () => {
    const { state } = await start();
    const res = await request(makeApp())
      .get("/api/v1/auth/google/callback")
      .set("Cookie", "eztd_oauth_login=someone-elses-nonce")
      .query({ code: "c", state });
    expect(res.headers.location).toBe("/login?error=oauth_state_invalid");
    expect(authenticateCalls).toBe(1);
  });

  it("rejects a replayed state", async () => {
    const { state, cookie } = await start();
    await request(makeApp())
      .get("/api/v1/auth/google/callback")
      .set("Cookie", cookie)
      .query({ code: "c", state });
    const replay = await request(makeApp())
      .get("/api/v1/auth/google/callback")
      .set("Cookie", cookie)
      .query({ code: "c", state });
    expect(replay.headers.location).toBe("/login?error=oauth_state_invalid");
  });

  it("answers a sign-in the user cancelled at the provider, and uses up its state", async () => {
    const { state, cookie } = await start();
    const res = await request(makeApp())
      .get("/api/v1/auth/google/callback")
      .set("Cookie", cookie)
      .query({ error: "access_denied", state });
    expect(res.headers.location).toBe("/login?error=oauth_cancelled");
    expect(authenticateCalls).toBe(1); // the provider is not asked to finish the sign-in
    const cleared = res.headers["set-cookie"].find((c) => c.startsWith("eztd_oauth_login="));
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    // The state cannot be used afterwards.
    const replay = await request(makeApp())
      .get("/api/v1/auth/google/callback")
      .set("Cookie", cookie)
      .query({ code: "c", state });
    expect(replay.headers.location).toBe("/login?error=oauth_state_invalid");
  });

  it("answers a cancelled sign-in without any state the same way", async () => {
    const res = await request(makeApp())
      .get("/api/v1/auth/google/callback")
      .query({ error: "access_denied" });
    expect(res.headers.location).toBe("/login?error=oauth_cancelled");
    expect(authenticateCalls).toBe(0);
  });

  it("redirects refused sign-ins with a specific error code", async () => {
    passport.use("google", {
      name: "google",
      authenticate(req, options) {
        if (req.query.code) {
          return this.success({
            provider: "google",
            providerId: "g-2",
            email: "u@x.com",
            emailVerified: false,
            linkByEmail: false,
            displayName: "U"
          });
        }
        return this.redirect(`https://provider.example/auth?state=${options.state}`);
      }
    });
    mocks.query.mockResolvedValue({ rows: [] });
    const { state, cookie } = await start();
    const res = await request(makeApp())
      .get("/api/v1/auth/google/callback")
      .set("Cookie", cookie)
      .query({ code: "c", state });
    expect(res.headers.location).toBe("/login?error=oauth_email_unverified");
  });
});

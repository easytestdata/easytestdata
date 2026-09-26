import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
}));

import { IntuitSSOStrategy, profileFromIdToken } from "../src/auth/passport-intuit-sso.js";

function idTokenFor(code) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64({
    sub: `sub-${code}`,
    email: `${code}@example.com`,
    emailVerified: true,
    givenName: code
  })}.sig`;
}

function makeStrategy() {
  return new IntuitSSOStrategy(
    { clientID: "id", clientSecret: "secret", callbackURL: "https://app.example/cb" },
    (_accessToken, _refreshToken, profile, done) =>
      done(null, { id: profile.id, email: profile.emails[0]?.value })
  );
}

/** Runs one callback-phase authenticate() the way passport does (an augmented strategy). */
function login(strategy, code) {
  return new Promise((resolve, reject) => {
    const s = Object.create(strategy);
    s.success = (user) => resolve(user);
    s.error = (err) => reject(err);
    s.fail = (info) => reject(new Error(`fail: ${JSON.stringify(info)}`));
    s.redirect = (url) => reject(new Error(`redirect: ${url}`));
    s.authenticate({ query: { code }, headers: {}, url: "/cb", method: "GET" }, {});
  });
}

describe("IntuitSSOStrategy", () => {
  let strategy;
  let exchange;
  const delays = { A: 30, B: 0 };

  beforeEach(() => {
    strategy = makeStrategy();
    exchange = vi.fn((code, _params, cb) => {
      setTimeout(
        () => cb(null, `at-${code}`, `rt-${code}`, { id_token: idTokenFor(code) }),
        delays[code] ?? 0
      );
    });
    strategy._oauth2.getOAuthAccessToken = exchange;
  });

  it("decodes a profile from an id_token and returns null for garbage", () => {
    expect(profileFromIdToken(idTokenFor("Z"))).toMatchObject({
      provider: "intuit",
      id: "sub-Z",
      emails: [{ value: "Z@example.com", verified: true }]
    });
    expect(profileFromIdToken("not.a.jwt")).toBeNull();
    expect(profileFromIdToken(undefined)).toBeNull();
  });

  it("uses the userinfo profile when the endpoint answers", async () => {
    strategy._oauth2.get = (_url, token, cb) =>
      cb(null, JSON.stringify({ sub: `info-${token}`, email: "info@example.com" }));
    await expect(login(strategy, "A")).resolves.toEqual({
      id: "info-at-A",
      email: "info@example.com"
    });
  });

  it("falls back to each request's own id_token when userinfo fails, even when logins interleave", async () => {
    strategy._oauth2.get = (_url, _token, cb) => cb(new Error("userinfo unavailable"));

    // A's token exchange starts first but finishes after B's.
    const [a, b] = await Promise.all([login(strategy, "A"), login(strategy, "B")]);

    expect(a).toEqual({ id: "sub-A", email: "A@example.com" });
    expect(b).toEqual({ id: "sub-B", email: "B@example.com" });
  });

  it("keeps no per-login state on the shared instance and does not wrap the token exchange", async () => {
    strategy._oauth2.get = (_url, _token, cb) => cb(new Error("userinfo unavailable"));
    await login(strategy, "A");
    await login(strategy, "B");

    expect(strategy._oauth2.getOAuthAccessToken).toBe(exchange);
    expect(exchange).toHaveBeenCalledTimes(2);
    expect(Object.keys(strategy).filter((key) => /token/i.test(key))).toEqual([]);
  });

  it("errors when neither userinfo nor an id_token yields a profile", async () => {
    strategy._oauth2.get = (_url, _token, cb) => cb(null, "not json");
    strategy._oauth2.getOAuthAccessToken = (code, _params, cb) =>
      cb(null, `at-${code}`, `rt-${code}`, {});
    await expect(login(strategy, "A")).rejects.toThrow(/Could not retrieve Intuit user profile/);
  });
});

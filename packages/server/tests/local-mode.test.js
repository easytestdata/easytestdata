import express from "express";
import request from "supertest";
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { localRequestGuards } from "../src/local/guards.js";
import { ensureLocalSecrets } from "../src/local/secrets.js";

// Review Focus 1: a malicious page in the same browser must not be able to use the no-login
// local API. The guards are tested on a bare app, then the real server is started in local
// mode (embedded PGlite in a temp data dir, never ~/.easytestdata) on 127.0.0.1:28183.
const root = mkdtempSync(join(tmpdir(), "eztd-local-"));
const dataDir = join(root, "data");
vi.stubEnv("DEPLOYMENT", "local");
vi.stubEnv("PORT", "28183");
vi.stubEnv("EASYTESTDATA_DATA_DIR", dataDir);
vi.stubEnv("JWT_SECRET", "");
vi.stubEnv("TOKEN_ENCRYPTION_KEY", "");
vi.stubEnv("JOB_ARTIFACTS_DIR", "");
vi.stubEnv("LOCAL_PUBLIC_URL", "");
vi.stubEnv("ADMIN_EMAILS", "local@easytestdata.local");
vi.mock("../src/logger.js", async () => {
  const { pino } = await import("pino");
  return { logger: pino({ level: "silent" }) };
});

const app = express()
  .use(localRequestGuards({ port: 28080, appUrl: "http://localhost:5173" }))
  .use(express.json())
  .post("/api/v1/jobs", (_req, res) => res.status(201).json({ ok: true }))
  .get("/api/v1/jobs", (_req, res) => res.json([]))
  .get("/api/v1/connections/callback", (_req, res) => res.send("ok"))
  .get("/api/v1/connections/authorize", (_req, res) => res.json({ url: "https://intuit" }));

const own = { host: "localhost:28080", "x-easytestdata": "1" };

describe("local request guards", () => {
  it("accepts the app's own and the dev server's requests", async () => {
    expect(
      (
        await request(app)
          .post("/api/v1/jobs")
          .set({ ...own, origin: "http://localhost:28080" })
          .send({})
      ).status
    ).toBe(201);
    expect(
      (
        await request(app)
          .post("/api/v1/jobs")
          .set({ ...own, origin: "http://localhost:5173" })
          .send({})
      ).status
    ).toBe(201);
  });
  it("lets the Intuit callback (a top-level GET) through", async () => {
    expect(
      (
        await request(app)
          .get("/api/v1/connections/callback?code=x")
          .set({ host: "localhost:28080" })
      ).status
    ).toBe(200);
  });
  it("refuses a cross-site GET that would allocate OAuth state (authorize)", async () => {
    // A foreign page can send credentialed or no-cors GETs but cannot add the custom header.
    for (const path of [
      "/api/v1/connections/authorize",
      "/API/v1/Connections/Authorize/",
      "/api/v1//connections/authorize?mode=popup"
    ]) {
      const res = await request(app).get(path).set({ host: "localhost:28080" });
      expect(res.status).toBe(403);
    }
    const foreign = await request(app)
      .get("/api/v1/connections/authorize")
      .set({ ...own, origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    // The app's own fetch (it always sends the header) still works.
    const ownFetch = await request(app).get("/api/v1/connections/authorize").set(own);
    expect(ownFetch.status).toBe(200);
  });
  it("refuses a DNS-rebinding Host", async () => {
    expect(
      (await request(app).get("/api/v1/jobs").set({ host: "evil.example:28080" })).status
    ).toBe(403);
  });
  it("refuses a cross-site Origin", async () => {
    expect(
      (
        await request(app)
          .post("/api/v1/jobs")
          .set({ ...own, origin: "https://evil.example" })
          .send({})
      ).status
    ).toBe(403);
  });
  it("requires the header whatever the path's spelling", async () => {
    const upper = await request(app).post("/API/v1/jobs").set({ host: "localhost:28080" }).send({});
    expect(upper.status).toBe(403);
  });
  it("refuses a form post or no-cors fetch (no custom header)", async () => {
    const form = await request(app)
      .post("/api/v1/jobs")
      .set({ host: "localhost:28080" })
      .type("form")
      .send("a=1");
    expect(form.status).toBe(403);
    const plain = await request(app)
      .post("/api/v1/jobs")
      .set({ host: "localhost:28080" })
      .set("content-type", "text/plain")
      .send("{}");
    expect(plain.status).toBe(403);
  });
  it("refuses every unsafe method without the header, and a header value other than 1", async () => {
    for (const method of ["put", "patch", "delete"]) {
      const res = await request(app)[method]("/api/v1/jobs").set({ host: "localhost:28080" });
      expect(res.status, method).toBe(403);
    }
    const wrong = await request(app)
      .post("/api/v1/jobs")
      .set({ host: "localhost:28080", "x-easytestdata": "true" })
      .send({});
    expect(wrong.status).toBe(403);
  });
  it("refuses a null Origin (sandboxed iframe) and a lookalike port", async () => {
    const nullOrigin = await request(app)
      .post("/api/v1/jobs")
      .set({ ...own, origin: "null" })
      .send({});
    expect(nullOrigin.status).toBe(403);
    const otherPort = await request(app)
      .post("/api/v1/jobs")
      .set({ ...own, origin: "http://localhost:28081" })
      .send({});
    expect(otherPort.status).toBe(403);
  });
  it("refuses anything that came through a proxy (browsers never send these to localhost)", async () => {
    for (const header of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"]) {
      const get = await request(app)
        .get("/api/v1/jobs")
        .set({ ...own, [header]: "203.0.113.9" });
      expect(get.status, header).toBe(403);
      const post = await request(app)
        .post("/api/v1/jobs")
        .set({ ...own, [header]: "203.0.113.9" })
        .send({});
      expect(post.status, header).toBe(403);
    }
  });
  it("refuses a missing Host and a Host on another port", async () => {
    expect((await request(app).get("/api/v1/jobs").set({ host: "" })).status).toBe(403);
    expect((await request(app).get("/api/v1/jobs").set({ host: "localhost:3000" })).status).toBe(
      403
    );
  });
});

describe("local secrets", () => {
  it("creates private secret files once and reuses them", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "eztd-sec-")), "data");
    const first = ensureLocalSecrets(dir);
    expect(first.encryptionKey).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(dir, "secret.key")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(ensureLocalSecrets(dir)).toEqual(first);
  });

  it("tightens an existing key file to 0600 and leaves no temp files behind", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "eztd-sec-")), "data");
    const first = ensureLocalSecrets(dir);
    expect(readdirSync(dir)).toEqual(["secret.key"]);
    chmodSync(join(dir, "secret.key"), 0o644);
    expect(ensureLocalSecrets(dir)).toEqual(first);
    expect(statSync(join(dir, "secret.key")).mode & 0o777).toBe(0o600);
  });

  it("derives a JWT secret that differs from the encryption key", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "eztd-sec-")), "data");
    const { jwtSecret, encryptionKey } = ensureLocalSecrets(dir);
    expect(jwtSecret.length).toBeGreaterThanOrEqual(32);
    expect(jwtSecret).not.toBe(encryptionKey);
  });

  it("refuses a damaged secret file instead of replacing it (stored tokens depend on it)", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "eztd-sec-")), "data");
    ensureLocalSecrets(dir);
    writeFileSync(join(dir, "secret.key"), "not-a-key");
    expect(() => ensureLocalSecrets(dir)).toThrow(/secret\.key/);
  });
});

describe("local mode server", () => {
  let server;
  let close;
  let config;
  let identity;

  beforeAll(async () => {
    ({ config } = await import("../src/config.js"));
    const { bootstrap } = await import("../src/start.js");
    ({ server, close } = await bootstrap({ listen: true }));
    identity = (await import("../src/local/identity.js")).getLocalIdentity();
  }, 60_000);

  afterAll(async () => {
    await close?.();
    rmSync(root, { recursive: true, force: true });
  });

  const local = () => request(server);

  it("listens on the loopback address only", () => {
    expect(server.address()).toMatchObject({ address: "127.0.0.1", port: 28183 });
    expect(config.host).toBe("127.0.0.1");
  });

  it("follows the port for the app URL and the Intuit redirect URI", () => {
    expect(config.appUrl).toBe("http://localhost:28183");
    expect(config.qbo.redirectUri).toBe("http://localhost:28183/api/v1/connections/callback");
  });

  it("creates the data dir and its secrets, and uses them", () => {
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    const secrets = ensureLocalSecrets(dataDir);
    expect(config.tokenEncryption.key).toBe(secrets.encryptionKey);
    expect(config.jwt.secret).toBe(secrets.jwtSecret);
  });

  it("saves first-run Intuit keys encrypted in the database and reports them configured", async () => {
    vi.stubEnv("QBO_CLIENT_ID", "");
    vi.stubEnv("QBO_CLIENT_SECRET", "");
    const own = { host: "localhost:28183", "x-easytestdata": "1" };
    const before = await local().get("/api/v1/config/public").set(own);
    expect(before.body.qboConfigured).toBe(false);

    const saved = await local()
      .put("/api/v1/setup/qbo")
      .set(own)
      .send({ clientId: "ABC", clientSecret: "s3cret" });
    expect(saved.status).toBe(200);

    const { query } = await import("../src/db/pool.js");
    const rows = (await query("SELECT * FROM app_settings")).rows;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("s3cret");
    const setup = await local().get("/api/v1/setup").set(own);
    expect(setup.body).toEqual({
      qboConfigured: true,
      redirectUri: "http://localhost:28183/api/v1/connections/callback"
    });
    const after = await local().get("/api/v1/config/public").set(own);
    expect(after.body.qboConfigured).toBe(true);
    expect(JSON.stringify(after.body)).not.toContain("s3cret");
  });

  it("keeps downloads under the data dir", async () => {
    const { getArtifactDir } = await import("../src/services/job-artifacts.js");
    expect(getArtifactDir()).toBe(join(dataDir, "exports"));
  });

  it("applies the unlimited local limits", async () => {
    const { DEPLOYMENT_LIMITS } = await import("@easytestdata/shared/constants");
    const { getDeployment, getLimits } = await import("../src/services/limits.js");
    expect(getDeployment()).toBe("local");
    expect(getLimits()).toBe(DEPLOYMENT_LIMITS.local);
    expect(Object.values(getLimits()).every((limit) => limit === -1)).toBe(true);
  });

  it("signs every request in as the one local user, with no Authorization header", async () => {
    const res = await local().get("/api/v1/auth/profile");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: identity.id, team_id: identity.teamId, is_admin: false });

    const { authenticate } = await import("../src/middleware/auth.js");
    const req = { headers: {} };
    const next = vi.fn();
    await authenticate(req, {}, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toMatchObject({
      id: identity.id,
      teamId: identity.teamId,
      role: "owner",
      isAdmin: false
    });
  });

  it("ensureLocalIdentity is idempotent: one user and team, never an admin", async () => {
    const { ensureLocalIdentity } = await import("../src/local/identity.js");
    const again = await ensureLocalIdentity();
    expect(again).toEqual(identity);
    const { query } = await import("../src/db/pool.js");
    const counts = await query(
      `SELECT (SELECT COUNT(*)::int FROM users) AS users,
              (SELECT COUNT(*)::int FROM teams) AS teams,
              (SELECT is_admin FROM users WHERE id = $1) AS is_admin,
              (SELECT active_team_id FROM users WHERE id = $1) AS active_team_id`,
      [identity.id]
    );
    expect(counts.rows[0]).toEqual({
      users: 1,
      teams: 1,
      is_admin: false,
      active_team_id: identity.teamId
    });
  });

  it("answers the app's own requests", async () => {
    const res = await local()
      .post("/api/v1/jobs/estimate")
      .set({ "x-easytestdata": "1", origin: "http://localhost:28183" })
      .send({});
    expect(res.status).toBe(400); // reached the route: validation, not a guard
    expect((await local().get("/api/v1/jobs")).status).toBe(200);
  });

  it("refuses cross-site writes: form post, no-cors fetch, foreign Origin, DNS rebinding", async () => {
    const form = await local().post("/api/v1/jobs").type("form").send("type=generate");
    expect(form.status).toBe(403);
    const noCors = await local()
      .post("/api/v1/jobs")
      .set({ "content-type": "text/plain", origin: "https://evil.example" })
      .send("{}");
    expect(noCors.status).toBe(403);
    const foreign = await local()
      .delete("/api/v1/connections/00000000-0000-0000-0000-000000000000")
      .set({ "x-easytestdata": "1", origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    const rebound = await local().get("/api/v1/jobs").set({ host: "evil.example:28183" });
    expect(rebound.status).toBe(403);
    const { query } = await import("../src/db/pool.js");
    expect((await query("SELECT COUNT(*)::int AS n FROM jobs")).rows[0].n).toBe(0);
  });

  it("never grants a CORS preflight", async () => {
    const res = await local().options("/api/v1/jobs").set({
      origin: "https://evil.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "x-easytestdata, content-type"
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-headers"]).toBeUndefined();
  });

  it("refuses to adopt the local email when it belongs to another sign-in provider", async () => {
    const { ensureLocalIdentity, getLocalIdentity } = await import("../src/local/identity.js");
    const { query } = await import("../src/db/pool.js");
    await query("UPDATE users SET oauth_provider = 'google' WHERE id = $1", [identity.id]);
    try {
      await expect(ensureLocalIdentity()).rejects.toThrow(/is not the local user/);
      expect(getLocalIdentity()).toEqual(identity); // the cached identity is untouched
    } finally {
      await query("UPDATE users SET oauth_provider = 'local' WHERE id = $1", [identity.id]);
    }
  });

  it("has no rate limit a cross-site page could exhaust (all requests share 127.0.0.1)", async () => {
    for (let i = 0; i < 310; i++) {
      const res = await local().get("/api/v1/templates/presets");
      if (res.status !== 200) throw new Error(`request ${i}: ${res.status}`);
    }
  });

  it("does not mount sign-in, teams, invites or admin", async () => {
    const write = { "x-easytestdata": "1" };
    for (const path of [
      "/api/v1/auth/google",
      "/api/v1/auth/github/callback",
      "/api/v1/auth/intuit",
      "/api/v1/teams",
      "/api/v1/admin/dashboard"
    ]) {
      expect((await local().get(path)).status, path).toBe(404);
    }
    for (const path of [
      "/api/v1/auth/refresh",
      "/api/v1/auth/oauth/exchange",
      "/api/v1/auth/switch-team",
      "/api/v1/teams/invites/accept"
    ]) {
      expect((await local().post(path).set(write).send({})).status, path).toBe(404);
    }
  });

  it("reports local mode in the public config", async () => {
    const res = await local().get("/api/v1/config/public");
    expect(res.body.deployment).toBe("local");
    expect(Object.keys(res.body).sort()).toEqual([
      "deployment",
      "enabledOAuthProviders",
      "marketingUrl",
      "qboConfigured",
      "qboRedirectUri",
      "sentryDsn",
      "version"
    ]);
    expect(res.body.qboRedirectUri).toBe("http://localhost:28183/api/v1/connections/callback");
  });
});

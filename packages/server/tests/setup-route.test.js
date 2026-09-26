import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Local mode: the Intuit keys a user types into the first-run setup page are stored encrypted in
// app_settings (an in-memory map here); keys set in the environment win.
vi.stubEnv("DEPLOYMENT", "local");
vi.stubEnv("PORT", "28080");
vi.stubEnv("LOCAL_PUBLIC_URL", "");
vi.stubEnv("TOKEN_ENCRYPTION_KEY", "ab".repeat(32));
vi.stubEnv("QBO_CLIENT_ID", "");
vi.stubEnv("QBO_CLIENT_SECRET", "");

const { settings, queryMock } = vi.hoisted(() => {
  const settings = new Map();
  const queryMock = vi.fn(async (sql, params = []) => {
    if (sql.includes("app_settings") && sql.includes("INSERT")) {
      settings.set(params[0], { value_enc: params[1], iv: params[2] });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("app_settings") && sql.includes("SELECT")) {
      const row = settings.get(params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { settings, queryMock };
});
vi.mock("../src/db/pool.js", () => ({ query: (...args) => queryMock(...args) }));
vi.mock("../src/logger.js", async () => {
  const { pino } = await import("pino");
  return { logger: pino({ level: "silent" }) };
});

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/server.js");
const { getQboCredentials } = await import("../src/services/app-settings.js");
const { buildPublicConfig } = await import("../src/public-config.js");
const { logger } = await import("../src/logger.js");

const localHeaders = {
  host: "localhost:28080",
  origin: "http://localhost:28080",
  "x-easytestdata": "1"
};
const app = createApp();

beforeEach(() => {
  settings.clear();
  queryMock.mockClear();
});

afterEach(() => {
  vi.stubEnv("QBO_CLIENT_ID", "");
  vi.stubEnv("QBO_CLIENT_SECRET", "");
});

describe("/api/v1/setup (local mode)", () => {
  it("reports whether keys are configured and the redirect URI to register", async () => {
    const res = await request(app).get("/api/v1/setup").set({ host: "localhost:28080" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      qboConfigured: false,
      redirectUri: "http://localhost:28080/api/v1/connections/callback"
    });
  });

  it("stores Intuit keys encrypted and reports them configured", async () => {
    const res = await request(app)
      .put("/api/v1/setup/qbo")
      .set(localHeaders)
      .send({ clientId: "ABC", clientSecret: "s3cret" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ qboConfigured: true });
    const insert = queryMock.mock.calls.find(
      ([sql]) => sql.includes("app_settings") && sql.includes("INSERT")
    );
    expect(JSON.stringify(insert[1])).not.toContain("s3cret");
    expect(await getQboCredentials()).toEqual({ clientId: "ABC", clientSecret: "s3cret" });

    const status = await request(app).get("/api/v1/setup").set({ host: "localhost:28080" });
    expect(status.body.qboConfigured).toBe(true);
    expect(JSON.stringify(status.body)).not.toContain("s3cret");
    const pub = await buildPublicConfig();
    expect(pub.qboConfigured).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("s3cret");
  });

  it("trims the keys before storing them", async () => {
    await request(app)
      .put("/api/v1/setup/qbo")
      .set(localHeaders)
      .send({ clientId: "  ABC ", clientSecret: " s3cret\n" })
      .expect(200);
    expect(await getQboCredentials()).toEqual({ clientId: "ABC", clientSecret: "s3cret" });
  });

  it("replaces keys saved earlier", async () => {
    for (const clientId of ["OLD", "NEW"]) {
      await request(app)
        .put("/api/v1/setup/qbo")
        .set(localHeaders)
        .send({ clientId, clientSecret: `${clientId}-secret` })
        .expect(200);
    }
    expect(await getQboCredentials()).toEqual({ clientId: "NEW", clientSecret: "NEW-secret" });
  });

  it("rejects empty keys", async () => {
    const res = await request(app)
      .put("/api/v1/setup/qbo")
      .set(localHeaders)
      .send({ clientId: " ", clientSecret: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Enter the Client ID.");
    expect(settings.size).toBe(0);
  });

  it("names a missing or non-text key in the error the setup page shows", async () => {
    for (const body of [{ clientSecret: "s" }, { clientId: 42, clientSecret: "s" }]) {
      const res = await request(app).put("/api/v1/setup/qbo").set(localHeaders).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Enter the Client ID.");
    }
    expect(settings.size).toBe(0);
  });

  it("rejects keys longer than 200 characters", async () => {
    const res = await request(app)
      .put("/api/v1/setup/qbo")
      .set(localHeaders)
      .send({ clientId: "A".repeat(201), clientSecret: "s" });
    expect(res.status).toBe(400);
    expect(settings.size).toBe(0);
  });

  it("refuses a save without the X-EasyTestData header (local guards)", async () => {
    const res = await request(app)
      .put("/api/v1/setup/qbo")
      .set({ host: "localhost:28080" })
      .send({ clientId: "ABC", clientSecret: "s3cret" });
    expect(res.status).toBe(403);
    expect(settings.size).toBe(0);
  });

  it("lets environment keys win over stored ones", async () => {
    await request(app)
      .put("/api/v1/setup/qbo")
      .set(localHeaders)
      .send({ clientId: "ABC", clientSecret: "s3cret" })
      .expect(200);
    vi.stubEnv("QBO_CLIENT_ID", "ENV");
    vi.stubEnv("QBO_CLIENT_SECRET", "ENVSECRET");
    expect(await getQboCredentials()).toEqual({ clientId: "ENV", clientSecret: "ENVSECRET" });
  });

  it("treats stored keys that no longer decrypt as not configured, and lets setup replace them", async () => {
    await request(app)
      .put("/api/v1/setup/qbo")
      .set(localHeaders)
      .send({ clientId: "ABC", clientSecret: "s3cret" })
      .expect(200);
    // Saved under another encryption key (e.g. TOKEN_ENCRYPTION_KEY was set then, not now).
    const originalKey = config.tokenEncryption.key;
    config.tokenEncryption.key = "cd".repeat(32);
    const warn = vi.spyOn(logger, "warn");
    try {
      expect(await getQboCredentials()).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("re-enter them on the setup page"));
      expect(JSON.stringify(warn.mock.calls)).not.toContain("s3cret");

      const pub = await request(app).get("/api/v1/config/public").set({ host: "localhost:28080" });
      expect(pub.status).toBe(200);
      expect(pub.body).toMatchObject({ deployment: "local", qboConfigured: false });
      // Every page load and job reads the keys: the warning is logged once per process.
      expect(await getQboCredentials()).toBeNull();
      const keyWarnings = warn.mock.calls.filter(([msg]) => String(msg).includes("re-enter them"));
      expect(keyWarnings).toHaveLength(1);

      await request(app)
        .put("/api/v1/setup/qbo")
        .set(localHeaders)
        .send({ clientId: "NEW", clientSecret: "fresh" })
        .expect(200);
      expect(await getQboCredentials()).toEqual({ clientId: "NEW", clientSecret: "fresh" });
    } finally {
      warn.mockRestore();
      config.tokenEncryption.key = originalKey;
    }
  });

  it("treats a garbled stored row as not configured", async () => {
    settings.set("qbo_credentials", { value_enc: "zz:yy", iv: "00" });
    expect(await getQboCredentials()).toBeNull();
  });

  it("answers null when nothing is configured", async () => {
    expect(await getQboCredentials()).toBeNull();
  });
});

describe("/api/v1/setup in Cloud", () => {
  it("is not mounted", async () => {
    const original = config.deployment;
    config.deployment = "cloud";
    try {
      const cloudApp = createApp();
      const res = await request(cloudApp).get("/api/v1/setup");
      expect(res.status).toBe(404);
      const put = await request(cloudApp)
        .put("/api/v1/setup/qbo")
        .send({ clientId: "ABC", clientSecret: "s3cret" });
      expect(put.status).toBe(404);
      expect(settings.size).toBe(0);
    } finally {
      config.deployment = original;
    }
  });

  it("never reads stored keys (only the environment)", async () => {
    const original = config.deployment;
    config.deployment = "cloud";
    try {
      expect(await getQboCredentials()).toBeNull();
      expect(queryMock).not.toHaveBeenCalled();
      vi.stubEnv("QBO_CLIENT_ID", "ENV");
      vi.stubEnv("QBO_CLIENT_SECRET", "ENVSECRET");
      expect(await getQboCredentials()).toEqual({ clientId: "ENV", clientSecret: "ENVSECRET" });
    } finally {
      config.deployment = original;
    }
  });
});

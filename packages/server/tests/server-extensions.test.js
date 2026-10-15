import express from "express";
import request from "supertest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { poolQuery, logInfo } = vi.hoisted(() => ({ poolQuery: vi.fn(), logInfo: vi.fn() }));
vi.mock("../src/db/pool.js", () => ({ query: (...args) => poolQuery(...args) }));
vi.mock("../src/logger.js", async () => {
  const { pino } = await import("pino");
  const logger = pino({ level: "silent" });
  vi.spyOn(logger, "info").mockImplementation(logInfo);
  return { logger };
});

describe("createApp extensions in local mode", () => {
  let root;
  let webDistDir;
  let createApp;
  const own = { host: "localhost:28184", "x-easytestdata": "1" };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "eztd-server-extensions-"));
    webDistDir = join(root, "web");
    mkdirSync(webDistDir);
    writeFileSync(join(webDistDir, "index.html"), "<html>extension web build</html>");
    vi.resetModules();
    vi.stubEnv("DEPLOYMENT", "local");
    vi.stubEnv("PORT", "28184");
    vi.stubEnv("EASYTESTDATA_DATA_DIR", join(root, "data"));
    vi.stubEnv("LOCAL_PUBLIC_URL", "");
    vi.stubEnv("SENTRY_DSN", "");
    ({ createApp } = await import("../src/server.js"));
  });

  beforeEach(() => {
    poolQuery.mockReset().mockResolvedValue({ rows: [] });
    logInfo.mockClear();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function app() {
    const router = express.Router();
    router.get("/ping", (req, res) => res.json({ ok: true, requestId: req.id }));
    router.post("/echo", (req, res) => res.status(201).json(req.body));
    router.get("/failure", () => {
      throw Object.assign(new Error("Extension conflict"), { status: 409 });
    });
    return createApp({ extensions: [{ name: "demo-ext", router }], webDistDir });
  }

  it("serves an explicit web build on /home without extensions", async () => {
    const res = await request(createApp({ webDistDir })).get("/home").set(own);
    expect(res.status).toBe(200);
    expect(res.text).toBe("<html>extension web build</html>");
    expect(logInfo).toHaveBeenCalledWith({ webDistDir }, "Serving web UI");
  });

  it("mounts a real extension GET router behind request IDs and security headers", async () => {
    const res = await request(app())
      .get("/api/v1/demo-ext/ping")
      .set({ ...own, "x-request-id": "extension-request" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, requestId: "extension-request" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("passes parsed JSON to an extension POST router", async () => {
    const res = await request(app()).post("/api/v1/demo-ext/echo").set(own).send({ value: 42 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ value: 42 });
  });

  it("requires the local custom header and accepts the same POST with it", async () => {
    const server = app();
    const blocked = await request(server)
      .post("/api/v1/demo-ext/echo")
      .set({ host: own.host })
      .send({ value: 42 });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("Missing X-EasyTestData header.");
    const accepted = await request(server)
      .post("/api/v1/demo-ext/echo")
      .set(own)
      .send({ value: 42 });
    expect(accepted.status).toBe(201);
    expect(accepted.body).toEqual({ value: 42 });
  });

  it("rejects a foreign Host and accepts the local Host", async () => {
    const server = app();
    const blocked = await request(server)
      .get("/api/v1/demo-ext/ping")
      .set({ host: "evil.example:28184" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("EasyTestData only answers on localhost.");
    const accepted = await request(server).get("/api/v1/demo-ext/ping").set({ host: own.host });
    expect(accepted.status).toBe(200);
    expect(accepted.body.ok).toBe(true);
  });

  it("rejects a foreign Origin and accepts the local Origin", async () => {
    const server = app();
    const blocked = await request(server)
      .post("/api/v1/demo-ext/echo")
      .set({ ...own, origin: "https://evil.example" })
      .send({ value: 42 });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("Cross-site requests are not allowed.");
    const accepted = await request(server)
      .post("/api/v1/demo-ext/echo")
      .set({ ...own, origin: "http://localhost:28184" })
      .send({ value: 42 });
    expect(accepted.status).toBe(201);
    expect(accepted.body).toEqual({ value: 42 });
  });

  it("handles extension errors with the existing error handler", async () => {
    const res = await request(app()).get("/api/v1/demo-ext/failure").set(own);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
      message: "Extension conflict",
      path: "/api/v1/demo-ext/failure"
    });
  });

  it("rejects invalid JSON before the extension and accepts valid JSON", async () => {
    const server = app();
    const blocked = await request(server)
      .post("/api/v1/demo-ext/echo")
      .set(own)
      .type("json")
      .send("{");
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toBe("Request body is not valid JSON.");
    const accepted = await request(server)
      .post("/api/v1/demo-ext/echo")
      .set(own)
      .send({ ok: true });
    expect(accepted.status).toBe(201);
    expect(accepted.body).toEqual({ ok: true });
  });

  it("keeps unknown API paths as 404 while serving the SPA and built-in routes", async () => {
    const server = app();
    for (const path of ["/api/v1/unknown", "/api/v1/demo-ext/unknown", "/API/v1/unknown"]) {
      const res = await request(server).get(path).set(own);
      expect(res.status, path).toBe(404);
      expect(res.text, path).not.toContain("extension web build");
    }
    const page = await request(server).get("/home").set(own);
    expect(page.status).toBe(200);
    expect(page.text).toBe("<html>extension web build</html>");
    const presets = await request(server).get("/api/v1/templates/presets").set(own);
    expect(presets.status).toBe(200);
    expect(presets.body.length).toBeGreaterThan(0);
  });

  it("preserves no-option behavior and the workspace-then-packed web lookup", async () => {
    const workspace = fileURLToPath(new URL("../../web/dist", import.meta.url));
    const expectedWebDistDir = existsSync(workspace)
      ? workspace
      : fileURLToPath(new URL("../web-dist", import.meta.url));
    for (const options of [undefined, {}, { extensions: [], webDistDir: undefined }]) {
      const server = createApp(options);
      expect(logInfo).toHaveBeenLastCalledWith(
        { webDistDir: expectedWebDistDir },
        "Serving web UI"
      );
      const health = await request(server).get("/health").set(own);
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ status: "ok" });
      const presets = await request(server).get("/api/v1/templates/presets").set(own);
      expect(presets.status).toBe(200);
      expect(presets.body.length).toBeGreaterThan(0);
      expect((await request(server).get("/api/v1/demo-ext/ping").set(own)).status).toBe(404);
    }
  });

  it.each([null, false, 42, {}, "", "   ", "relative/web", "./web"])(
    "rejects invalid webDistDir %j and accepts an absolute directory",
    (invalid) => {
      expect(() => createApp({ webDistDir: invalid })).toThrow(/webDistDir.*absolute/i);
      expect(logInfo).not.toHaveBeenCalled();
      expect(() => createApp({ webDistDir })).not.toThrow();
    }
  );

  it("keeps an explicit missing web build instead of falling back to the default", async () => {
    const missing = join(root, "missing-web");
    const res = await request(createApp({ webDistDir: missing }))
      .get("/home")
      .set(own);
    expect(logInfo).toHaveBeenCalledWith({ webDistDir: missing }, "Serving web UI");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_FOUND", path: "/home" });
  });

  it.each([
    ["non-array", null],
    ["object instead of array", {}],
    ["non-plain descriptor", [null]],
    ["invalid name", [{ name: "a" }]],
    ["reserved name", [{ name: "auth" }]],
    ["duplicate names", [{ name: "demo-ext" }, { name: "demo-ext" }]],
    ["invalid router", [{ name: "demo-ext", router: {} }]],
    ["invalid onStart", [{ name: "demo-ext", onStart: false }]],
    ["invalid onStopping", [{ name: "demo-ext", onStopping: false }]],
    ["invalid onStop", [{ name: "demo-ext", onStop: false }]],
    ["invalid migrationsDir", [{ name: "demo-ext", migrationsDir: "" }]]
  ])(
    "validates %s before constructing the app and accepts valid descriptors",
    (_label, extensions) => {
      expect(() => createApp({ extensions, webDistDir })).toThrow();
      expect(logInfo).not.toHaveBeenCalled();
      const hook = vi.fn();
      expect(() =>
        createApp({
          extensions: [
            {
              name: "demo-ext",
              router: express.Router(),
              migrationsDir: join(root, "migrations"),
              onStart: hook,
              onStopping: hook,
              onStop: hook
            },
            { name: "other-ext" }
          ],
          webDistDir
        })
      ).not.toThrow();
      expect(hook).not.toHaveBeenCalled();
    }
  );
});

describe("createApp extensions in Cloud mode", () => {
  let root;
  let createApp;
  let authenticate;
  let signAccessToken;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "eztd-cloud-extensions-"));
    vi.resetModules();
    vi.stubEnv("DEPLOYMENT", "cloud");
    vi.stubEnv("PORT", "28185");
    vi.stubEnv("EASYTESTDATA_DATA_DIR", join(root, "data"));
    vi.stubEnv("JWT_SECRET", "test-extension-cloud-jwt-secret-32-chars");
    ({ createApp } = await import("../src/server.js"));
    ({ authenticate } = await import("../src/middleware/auth.js"));
    ({ signAccessToken } = await import("../src/auth/tokens.js"));
  });

  beforeEach(() => {
    poolQuery.mockReset();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("leaves auth to the router: public access works, protected access requires a valid session", async () => {
    const router = express.Router();
    router.get("/public", (_req, res) => res.json({ public: true }));
    router.get("/protected", authenticate, (req, res) => res.json({ teamId: req.user.teamId }));
    const server = createApp({ extensions: [{ name: "demo-ext", router }] });

    const publicRes = await request(server).get("/api/v1/demo-ext/public");
    expect(publicRes.status).toBe(200);
    expect(publicRes.body).toEqual({ public: true });
    const blocked = await request(server).get("/api/v1/demo-ext/protected");
    expect(blocked.status).toBe(401);
    expect(blocked.body.error).toBe("Authorization header required");
    expect(poolQuery).not.toHaveBeenCalled();

    poolQuery.mockResolvedValue({
      rows: [{ id: "user-1", session_version: 0, memberships: { "team-1": "owner" } }]
    });
    const token = signAccessToken({ sub: "user-1", teamId: "team-1", sv: 0 });
    const accepted = await request(server)
      .get("/api/v1/demo-ext/protected")
      .set("Authorization", `Bearer ${token}`);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ teamId: "team-1" });
    expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining("FROM users"), ["user-1"]);
  });
});

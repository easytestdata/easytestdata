import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import http from "node:http";
import { rateLimiter, SENSITIVE_AUTH_PATHS } from "../src/middleware/rate-limiter.js";
import { normalizeRoutePath } from "../src/http/route-path.js";
import { config } from "../src/config.js";
import { rateLimits } from "../src/state/memory.js";

const AUTH_LIMIT = config.rateLimit.authLimit;
const IP_LIMIT = config.rateLimit.ipLimit;

function makeApp() {
  const app = express();
  app.use(rateLimiter());
  app.post("/api/v1/auth/refresh", (req, res) => res.json({ ip: req.ip }));
  app.post("/api/v1/auth/oauth/exchange", (req, res) => res.json({ ip: req.ip }));
  app.get("/api/v1/config/public", (_req, res) => res.json({ ok: true }));
  return app;
}

// One real request (which counts), then the rest of the auth bucket filled directly: sending
// AUTH_LIMIT requests through supertest is too slow under the parallel monorepo run.
async function exhaustAuthBucket(app) {
  const res = await request(app).post("/api/v1/auth/refresh").send({});
  expect(res.status).toBe(200);
  for (let i = 1; i < AUTH_LIMIT; i++) rateLimits.hit(`auth:${res.body.ip}`, AUTH_LIMIT, 60_000);
}

describe("rate limiter", () => {
  beforeEach(() => {
    rateLimits.clear();
  });

  it("limits the sensitive auth routes per IP with the strict auth bucket", async () => {
    const app = makeApp();
    await exhaustAuthBucket(app);
    const res = await request(app).post("/api/v1/auth/refresh").send({});

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("Too many authentication attempts. Try again later.");
    // Other routes stay on the (larger) IP bucket.
    expect((await request(app).get("/api/v1/config/public")).status).toBe(200);
  });

  it("treats the OAuth code exchange as a sensitive auth route", async () => {
    const app = makeApp();
    await exhaustAuthBucket(app);
    const res = await request(app).post("/api/v1/auth/oauth/exchange").send({});

    expect(res.status).toBe(429);
  });

  it("limits every route per IP", async () => {
    const app = express();
    app.set("trust proxy", true);
    app.use(rateLimiter());
    app.get("/api/v1/config/public", (_req, res) => res.json({ ok: true }));
    for (let i = 0; i < IP_LIMIT; i++) rateLimits.hit("ip:203.0.113.9", IP_LIMIT, 60_000);
    const res = await request(app)
      .get("/api/v1/config/public")
      .set("X-Forwarded-For", "203.0.113.9");

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("Rate limit exceeded. Please try again later.");
    // Another client is unaffected.
    const other = await request(app)
      .get("/api/v1/config/public")
      .set("X-Forwarded-For", "203.0.113.10");
    expect(other.status).toBe(200);
  });

  it("puts exactly the two credential-taking auth routes in the strict bucket", () => {
    expect([...SENSITIVE_AUTH_PATHS].sort()).toEqual(
      ["/api/v1/auth/oauth/exchange", "/api/v1/auth/refresh"].sort()
    );
  });

  it.each([
    "/api/v1/auth/refresh/",
    "/api/v1/auth/REFRESH",
    "/api/v1/auth/Refresh//",
    "/api/v1//auth/refresh",
    "/api/v1/auth/%72efresh"
  ])("keeps the spelling variant %s in the sensitive bucket", async (path) => {
    const app = makeApp();
    await exhaustAuthBucket(app);
    const res = await request(app).post(path).send({});

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("Too many authentication attempts. Try again later.");
  });

  it("normalizes case, repeated and trailing slashes and percent-encoding", () => {
    expect(normalizeRoutePath("/api/v1/auth/REFRESH/")).toBe("/api/v1/auth/refresh");
    expect(normalizeRoutePath("/api//v1/auth/refresh//")).toBe("/api/v1/auth/refresh");
    expect(normalizeRoutePath("/api/v1/auth/%72efresh")).toBe("/api/v1/auth/refresh");
    expect(normalizeRoutePath("/")).toBe("/");
    expect(normalizeRoutePath("/%E0%A4%A")).toBe("/%e0%a4%a");
  });

  it("never treats a path Express routes to a sensitive handler as non-sensitive", async () => {
    // Express ignores case and a trailing slash but not much else (Express does not route an
    // inner //, which leaves 7 of these variants); the normalizer may over-match
    // (fine) but every spelling Express actually routes must land in the sensitive set.
    const app = express();
    const auth = express.Router();
    for (const route of ["/refresh", "/oauth/exchange"]) {
      auth.post(route, (_req, res) => res.json({ routed: true }));
    }
    app.use("/api/v1/auth", auth);
    app.use((_req, res) => res.status(404).json({ routed: false }));
    const server = await new Promise((resolve) => {
      const s = http.createServer(app);
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = server.address();
    const rawRequest = (path) =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path, method: "POST" }, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(JSON.parse(body).routed));
        });
        req.on("error", reject);
        req.end();
      });
    const variants = [
      "/api/v1/auth/refresh",
      "/api/v1/auth/refresh/",
      "/api/v1/auth/REFRESH",
      "/API/V1/AUTH/REFRESH/",
      "/api/v1/auth/Refresh//",
      "/api/v1//auth/refresh",
      "/api/v1/auth//refresh",
      "//api/v1/auth/refresh",
      "/api/v1/auth/%72efresh",
      "/api/v1/auth/ref%72esh",
      "/api/v1/auth/refresh%2F",
      "/api/v1/auth/refresh/%2F",
      "/api/v1/auth/refresh/.",
      "/api/v1/auth/x/../refresh",
      "/api/v1/auth/refresh;x",
      "/api/v1/auth/refresh%20",
      "/api/v1/auth/refresh?x=1",
      "/api/v1/auth/oauth//exchange",
      "/api/v1/auth/oauth/exchange/",
      "/api/v1/auth/OAUTH/EXCHANGE"
    ];
    try {
      let routedCount = 0;
      for (const path of variants) {
        const routed = await rawRequest(path);
        if (!routed) continue;
        routedCount++;
        expect(SENSITIVE_AUTH_PATHS.has(normalizeRoutePath(path.split("?")[0])), path).toBe(true);
      }
      expect(routedCount).toBeGreaterThanOrEqual(7);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { parseTrustProxy } from "../src/config.js";
import {
  applyTrustProxy,
  buildContentSecurityPolicy,
  createHttpLogger,
  REDACTED_LOG_PATHS,
  requestIdMiddleware,
  scrubSentryEvent,
  stripQuery
} from "../src/http/setup.js";
import { rateLimiter } from "../src/middleware/rate-limiter.js";
import { rateLimits } from "../src/state/memory.js";

describe("TRUST_PROXY parsing", () => {
  it("defaults to trusting nothing", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
  });

  it("accepts hop counts, presets and subnet lists", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("loopback")).toEqual(["loopback"]);
    expect(parseTrustProxy("loopback, 10.0.0.0/8")).toEqual(["loopback", "10.0.0.0/8"]);
    expect(parseTrustProxy("true")).toBe(true);
  });
});

// These tests send 20+ sequential requests through the limiter; under the full parallel
// monorepo run they can exceed vitest's 5 s default, so give the block a realistic ceiling.
describe("rate limiting keys on the resolved client IP", { timeout: 30_000 }, () => {
  function makeApp(trustProxy) {
    const app = express();
    applyTrustProxy(app, trustProxy);
    app.use(rateLimiter());
    app.post("/api/v1/auth/refresh", (req, res) => res.json({ ip: req.ip }));
    return app;
  }

  beforeEach(() => {
    rateLimits.clear();
  });

  it("with TRUST_PROXY=1, clients behind the proxy get separate auth buckets", async () => {
    const app = makeApp(1);
    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .post("/api/v1/auth/refresh")
        .set("X-Forwarded-For", "203.0.113.10");
      expect(res.status).toBe(200);
    }
    const blocked = await request(app)
      .post("/api/v1/auth/refresh")
      .set("X-Forwarded-For", "203.0.113.10");
    expect(blocked.status).toBe(429);

    // A different client behind the same proxy is unaffected.
    const other = await request(app)
      .post("/api/v1/auth/refresh")
      .set("X-Forwarded-For", "198.51.100.7");
    expect(other.status).toBe(200);
    expect(other.body.ip).toBe("198.51.100.7");
  });

  it("without TRUST_PROXY, X-Forwarded-For is ignored (cannot be spoofed)", async () => {
    const app = makeApp(false);
    // The spoofed address's auth bucket is full; the request is not counted against it.
    for (let i = 0; i < 20; i++) rateLimits.hit("auth:203.0.113.10", 20, 60_000);
    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .set("X-Forwarded-For", "203.0.113.10");
    expect(res.status).toBe(200);
    expect(res.body.ip).not.toBe("203.0.113.10");
  });
});

describe("request logging never records credentials", () => {
  function captureLogger() {
    const lines = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      }
    });
    return { logger: pino({ level: "info" }, stream), lines };
  }

  for (const verbose of [true, false]) {
    it(`redacts Authorization/Cookie and strips query strings (verbose=${verbose})`, async () => {
      const { logger, lines } = captureLogger();
      const app = express();
      app.use(requestIdMiddleware());
      app.use(createHttpLogger(logger, { verbose }));
      app.get("/api/v1/jobs", (_req, res) => res.json({ ok: true }));

      const jwtSecret = "eyJhbGciOiJIUzI1NiJ9.secret-access-token.sig";
      await request(app)
        .get("/api/v1/jobs?token=query-token-123&auth_code=code-456&state=st-789")
        .set("Authorization", `Bearer ${jwtSecret}`)
        .set("Cookie", "eztd_oauth_login=nonce-abc");
      await request(app)
        .get("/api/v1/jobs?invite_token=inv-000")
        .set("Authorization", "Bearer opaque-bearer-secret");
      // The page the browser is on (e.g. /invite?token=...) travels in the Referer header.
      await request(app)
        .get("/api/v1/jobs")
        .set("Referer", "https://app.example.com/invite?token=referer-invite-111");

      const output = lines.join("");
      expect(output).toContain("/api/v1/jobs");
      for (const secret of [
        jwtSecret,
        "query-token-123",
        "code-456",
        "st-789",
        "nonce-abc",
        "inv-000",
        "opaque-bearer-secret",
        "referer-invite-111"
      ]) {
        expect(output).not.toContain(secret);
      }
      if (verbose) expect(output).toContain("https://app.example.com/invite?[redacted]");
    });
  }

  it("redacts exactly the credential headers", () => {
    expect(REDACTED_LOG_PATHS).toEqual([
      "req.headers.authorization",
      "req.headers.cookie",
      'res.headers["set-cookie"]'
    ]);
  });

  it("scrubs the page URL and Referer from Sentry events", () => {
    const event = scrubSentryEvent({
      request: {
        url: "https://app.example.com/api/v1/jobs?auth_code=c-1",
        query_string: "auth_code=c-1",
        headers: { referer: "https://app.example.com/login?state=m-2", accept: "*/*" }
      }
    });
    expect(JSON.stringify(event)).not.toMatch(/c-1|m-2/);
    expect(event.request.headers).toEqual({
      referer: "https://app.example.com/login?[redacted]",
      accept: "*/*"
    });
    expect(scrubSentryEvent({ message: "no request" })).toEqual({ message: "no request" });
  });

  it("scrubs transactions too: their request, span and trace URLs and queries", () => {
    const event = scrubSentryEvent({
      type: "transaction",
      transaction: "GET /api/v1/jobs",
      request: {
        url: "https://app.example.com/api/v1/jobs?auth_code=t-1",
        headers: { referer: "https://app.example.com/invite?token=t-2" }
      },
      contexts: {
        trace: {
          data: { "http.url": "https://app.example.com/x?token=t-3", "http.query": "?token=t-3" }
        }
      },
      spans: [
        {
          description: "GET https://oauth.example/cb?code=t-4",
          data: {
            "url.full": "https://oauth.example/cb?code=t-4",
            "http.target": "/cb?code=t-4",
            "url.query": "code=t-4",
            "http.method": "GET"
          }
        },
        { description: "db query" }
      ]
    });
    expect(JSON.stringify(event)).not.toMatch(/t-[1-4]/);
    expect(event.spans[0].data).toMatchObject({
      "url.full": "https://oauth.example/cb?[redacted]",
      "http.target": "/cb?[redacted]",
      "http.method": "GET"
    });
    expect(event.spans[1]).toEqual({ description: "db query" });
  });

  it("stripQuery keeps the path only", () => {
    expect(stripQuery("/invite?token=abc")).toBe("/invite?[redacted]");
    expect(stripQuery("/home")).toBe("/home");
  });
});

describe("X-Request-Id handling", () => {
  function makeApp() {
    const app = express();
    app.use(requestIdMiddleware());
    app.get("/", (req, res) => res.json({ id: req.id }));
    return app;
  }

  it("keeps a short, plain caller id", async () => {
    const res = await request(makeApp()).get("/").set("X-Request-Id", "abc-123");
    expect(res.body.id).toBe("abc-123");
  });

  it("replaces oversized or unusual ids", async () => {
    const long = await request(makeApp()).get("/").set("X-Request-Id", "a".repeat(200));
    expect(long.body.id).not.toBe("a".repeat(200));
    const weird = await request(makeApp()).get("/").set("X-Request-Id", "evil <script>");
    expect(weird.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("Content-Security-Policy", () => {
  function directive(csp, name) {
    const found = csp.split("; ").find((d) => d.startsWith(`${name} `));
    return found ? found.split(" ").slice(1) : [];
  }

  it("allows the Sentry ingest origin of each configured DSN", () => {
    const csp = buildContentSecurityPolicy({
      sentryDsns: [
        "https://abc123@o0.ingest.sentry.io/451",
        undefined,
        "not a url",
        "https://def@o0.ingest.sentry.io/452"
      ]
    });
    const connect = directive(csp, "connect-src");
    expect(connect.filter((s) => s === "https://o0.ingest.sentry.io")).toHaveLength(1);
    expect(csp).not.toContain("abc123");
  });

  it("keeps the base policy", () => {
    const csp = buildContentSecurityPolicy();
    expect(directive(csp, "default-src")).toEqual(["'self'"]);
    expect(directive(csp, "connect-src")).toEqual(["'self'"]);
    expect(directive(csp, "script-src")).toEqual(["'self'"]);
    // Nothing third-party is scripted or framed.
    expect(csp).not.toContain("challenges.cloudflare.com");
    expect(csp).not.toContain("frame-src");
  });
});

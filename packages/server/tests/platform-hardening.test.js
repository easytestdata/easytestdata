import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  user: null,
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn()
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args) => mocks.query(...args)
}));

vi.mock("../src/middleware/auth.js", () => ({
  authenticate: (req, _res, next) => {
    req.user = mocks.user;
    next();
  }
}));

vi.mock("../src/workers/runner.js", () => ({ notifyJobQueued: vi.fn() }));

vi.mock("../src/logger.js", () => ({
  logger: {
    info: (...args) => mocks.loggerInfo(...args),
    warn: (...args) => mocks.loggerWarn(...args),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
  }
}));

import { config } from "../src/config.js";
import { collectStartupProblems } from "../src/startup-checks.js";
import { csvCell, neutralizeFormula, toCsv } from "../src/services/csv.js";
import { adminRoutes } from "../src/routes/admin/index.js";
import { buildPublicConfig } from "../src/public-config.js";

describe("startup configuration checks", () => {
  const prod = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://x",
    JWT_SECRET: "x".repeat(48),
    TOKEN_ENCRYPTION_KEY: "a".repeat(64),
    APP_URL: "https://app.example"
  };

  it("accepts a sane production configuration", () => {
    expect(collectStartupProblems(prod).fatal).toEqual([]);
    expect(collectStartupProblems({ ...prod, DEPLOYMENT: " Cloud " }).fatal).toEqual([]);
  });

  it("accepts only DEPLOYMENT=cloud or local", () => {
    for (const deployment of ["hosted", "production", "locale"]) {
      expect(collectStartupProblems({ DEPLOYMENT: deployment }).fatal[0]).toContain(
        'DEPLOYMENT must be "cloud" or "local"'
      );
    }
  });

  it("requires nothing in explicit local mode, even in production", () => {
    expect(
      collectStartupProblems({ NODE_ENV: "production", DEPLOYMENT: "local", APP_URL: "https://x" })
    ).toEqual({ fatal: [], warnings: [] });
    expect(collectStartupProblems({})).toEqual({ fatal: [], warnings: [] });
    expect(
      collectStartupProblems({
        NODE_ENV: "production",
        DEPLOYMENT: "LOCAL",
        DATABASE_URL: "postgres://inherited"
      })
    ).toEqual({ fatal: [], warnings: [] });
  });

  it("refuses to fall back to local mode on what looks like a Cloud server", () => {
    // No DEPLOYMENT and no DATABASE_URL would silently run the no-login app.
    for (const env of [
      { NODE_ENV: "production" },
      { TRUST_PROXY: "1" },
      { APP_URL: "https://app.example" }
    ]) {
      expect(collectStartupProblems(env).fatal, JSON.stringify(env)).toEqual([
        "Set DEPLOYMENT=cloud with DATABASE_URL, or DEPLOYMENT=local"
      ]);
    }
    expect(collectStartupProblems({ DEPLOYMENT: "local", TRUST_PROXY: "1" }).fatal).toEqual([]);
  });

  it("validates JWT_SECRET and TOKEN_ENCRYPTION_KEY given to local mode", () => {
    const local = { DEPLOYMENT: "local" };
    expect(collectStartupProblems({ ...local, JWT_SECRET: "short" }).fatal[0]).toContain(
      "at least 32"
    );
    expect(
      collectStartupProblems({ ...local, JWT_SECRET: "change-me-to-a-random-64-char-string" })
        .fatal[0]
    ).toContain("default");
    expect(collectStartupProblems({ ...local, TOKEN_ENCRYPTION_KEY: "nothex" }).fatal[0]).toContain(
      "TOKEN_ENCRYPTION_KEY"
    );
    expect(
      collectStartupProblems({
        ...local,
        JWT_SECRET: "x".repeat(32),
        TOKEN_ENCRYPTION_KEY: "a".repeat(64)
      }).fatal
    ).toEqual([]);
  });

  it("ignores a LOCAL_PUBLIC_URL that is not on localhost, with a warning", () => {
    const local = { DEPLOYMENT: "local" };
    expect(collectStartupProblems({ ...local, LOCAL_PUBLIC_URL: "http://localhost:5173" })).toEqual(
      { fatal: [], warnings: [] }
    );
    expect(
      collectStartupProblems({ ...local, LOCAL_PUBLIC_URL: "http://127.0.0.1:5173" }).warnings
    ).toEqual([]);
    for (const url of ["http://evil.example:5173", "http://localhost.evil.example", "nonsense"]) {
      expect(collectStartupProblems({ ...local, LOCAL_PUBLIC_URL: url }).warnings[0]).toContain(
        "LOCAL_PUBLIC_URL"
      );
    }
  });

  it("requires a JWT_SECRET of at least 32 chars and a hex TOKEN_ENCRYPTION_KEY in production", () => {
    expect(collectStartupProblems({ ...prod, JWT_SECRET: "short" }).fatal[0]).toContain(
      "at least 32"
    );
    expect(
      collectStartupProblems({ ...prod, JWT_SECRET: "change-me-to-a-random-64-char-string" })
        .fatal[0]
    ).toContain("default");
    expect(collectStartupProblems({ ...prod, TOKEN_ENCRYPTION_KEY: "nothex" }).fatal[0]).toContain(
      "TOKEN_ENCRYPTION_KEY"
    );
    expect(
      collectStartupProblems({ ...prod, DEPLOYMENT: "cloud", DATABASE_URL: "" }).fatal[0]
    ).toContain("DATABASE_URL");
  });
});

describe("CSV formula-injection guard", () => {
  it("prefixes formula-looking text with a single quote", () => {
    for (const value of ["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\tx", "\rx"]) {
      expect(neutralizeFormula(value)).toBe(`'${value}`);
    }
  });

  it("leaves plain numbers and normal text alone and quotes per RFC 4180", () => {
    expect(neutralizeFormula("-12.5")).toBe("-12.5");
    expect(neutralizeFormula("+3")).toBe("+3");
    expect(csvCell("Acme, Inc.")).toBe('"Acme, Inc."');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(toCsv(["a", "b"], [[1, null]])).toBe("a,b\n1,");
  });
});

describe("admin routes", () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/v1/admin", adminRoutes());
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { id: "admin-1", teamId: "t1", role: "owner", isAdmin: true };
    mocks.query.mockImplementation(async (sql) => {
      if (sql.includes("FROM users u ORDER BY u.created_at DESC")) {
        return {
          rows: [
            {
              id: "u1",
              email: "a@x.com",
              display_name: '=HYPERLINK("https://evil")',
              oauth_provider: "google",
              is_admin: false,
              suspended_at: null,
              created_at: new Date("2026-01-01T00:00:00Z")
            }
          ]
        };
      }
      return { rows: [] };
    });
  });

  it.each([
    ["get", "/api/v1/admin/dashboard"],
    ["get", "/api/v1/admin/users"],
    ["get", "/api/v1/admin/users/export"],
    ["get", "/api/v1/admin/Users/Export//"],
    ["post", "/api/v1/admin/users/u1/suspend"],
    ["post", "/api/v1/admin/jobs/j1/force-fail"],
    ["get", "/api/v1/admin/connections"]
  ])("refuses a non-admin on %s %s", async (method, path) => {
    mocks.user = { ...mocks.user, isAdmin: false };
    const res = await request(makeApp())[method](path).send({});
    expect(res.status, `${method} ${path}`).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("reports server health on the overview", async () => {
    mocks.query.mockImplementation(async (sql) =>
      sql.includes("GROUP BY status")
        ? { rows: [{ status: "failed", count: 2 }] }
        : { rows: [{ total_entities: "0" }] }
    );
    const res = await request(makeApp()).get("/api/v1/admin/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.system).toMatchObject({
      database: "ok",
      nodeVersion: process.version,
      jobsByStatus: { failed: 2 }
    });
    expect(res.body.system.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(res.body.system.memoryMb.rss).toBeGreaterThan(0);
  });

  it("exports users as formula-safe CSV", async () => {
    const res = await request(makeApp()).get("/api/v1/admin/users/export");
    expect(res.status).toBe(200);
    expect(res.text).toContain(`"'=HYPERLINK(""https://evil"")"`);
    expect(res.text.split("\n")[0]).toBe(
      "id,email,display_name,oauth_provider,is_admin,suspended,created_at"
    );
  });
});

describe("public config", () => {
  it("lists only Google, GitHub and Intuit sign-in", async () => {
    const original = { ...config.oauth.google };
    config.oauth.google.clientId = "gid";
    config.oauth.google.clientSecret = "gsecret";
    try {
      const pub = await buildPublicConfig();
      expect(pub.enabledOAuthProviders).toContain("google");
      expect(
        pub.enabledOAuthProviders.every((p) => ["google", "github", "intuit"].includes(p))
      ).toBe(true);
    } finally {
      Object.assign(config.oauth.google, original);
    }
  });
});

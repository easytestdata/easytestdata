import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// `easytestdata ui` runs local mode with NODE_ENV=production over plain http://localhost. Boot it
// the same way (startLocalServer, embedded PGlite in a temp data dir, never ~/.easytestdata) and
// pin the production-only behaviour that must still suit a browser on localhost.
const PORT = 28187;
const root = mkdtempSync(join(tmpdir(), "eztd-local-prod-"));
vi.stubEnv("NODE_ENV", "production");
vi.stubEnv("JWT_SECRET", "");
vi.stubEnv("TOKEN_ENCRYPTION_KEY", "");
vi.stubEnv("JOB_ARTIFACTS_DIR", "");
vi.stubEnv("LOCAL_PUBLIC_URL", "");
vi.stubEnv("TRUST_PROXY", "");
vi.stubEnv("APP_URL", "");
vi.stubEnv("QBO_CLIENT_ID", "test-client-id");
vi.stubEnv("QBO_CLIENT_SECRET", "test-client-secret");
delete process.env.LOG_LEVEL;

const base = `http://localhost:${PORT}`;
const own = { "x-easytestdata": "1" };

describe("local mode as the CLI runs it (NODE_ENV=production)", () => {
  let server;

  beforeAll(async () => {
    const { startLocalServer } = await import("../src/local/start-local.js");
    server = await startLocalServer({ port: PORT, dataDir: join(root, "data"), open: false });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("sets the QBO-connect state cookie without Secure (Safari drops it on http)", async () => {
    const res = await fetch(`${base}/api/v1/connections/authorize`, { headers: own });
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("eztd_qbo_connect="));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).not.toMatch(/;\s*Secure/i);
  });

  it("sends the production Content-Security-Policy, allowing provider avatars", async () => {
    const res = await fetch(`${base}/`);
    const csp = res.headers.get("content-security-policy");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/img-src [^;]*https:\/\/lh3\.googleusercontent\.com/);
    expect(csp).toMatch(/img-src [^;]*https:\/\/avatars\.githubusercontent\.com/);
  });

  it("keeps the terminal quiet: warnings and errors only, no per-request logs", async () => {
    const { logger } = await import("../src/logger.js");
    expect(logger.level).toBe("warn");
    expect(logger.isLevelEnabled("info")).toBe(false);
    expect(logger.isLevelEnabled("warn")).toBe(true);
  });
});

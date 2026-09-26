/**
 * Centralized test utilities for @easytestdata/server.
 *
 * Provides shared constants, mock factories, and helpers to reduce
 * boilerplate across test files.
 */
import express from "express";
import { vi } from "vitest";
import { signAccessToken } from "../src/auth/tokens.js";

// ── Shared test constants ───────────────────────────────────────────────────

export const TEST_USER_ID = "user-1";
export const TEST_TEAM_ID = "team-1";
export const TEST_USER_EMAIL = "user@example.com";
export const TEST_USER_ROLE = "owner";
export const TEST_ADMIN_ID = "admin-1";
export const TEST_CONNECTION_ID = "11111111-1111-1111-1111-111111111111";

// ── Mock user factories ─────────────────────────────────────────────────────

export function createMockUser(overrides = {}) {
  return {
    id: TEST_USER_ID,
    email: TEST_USER_EMAIL,
    teamId: TEST_TEAM_ID,
    role: TEST_USER_ROLE,
    ...overrides
  };
}

export function createMockAdmin(overrides = {}) {
  return {
    id: TEST_ADMIN_ID,
    email: "admin@example.com",
    teamId: TEST_TEAM_ID,
    role: "owner",
    isAdmin: true,
    ...overrides
  };
}

// ── JWT helpers ─────────────────────────────────────────────────────────────

export function signTestToken(overrides = {}, options = {}) {
  const payload = {
    sub: TEST_USER_ID,
    email: TEST_USER_EMAIL,
    teamId: TEST_TEAM_ID,
    role: TEST_USER_ROLE,
    // Session generation; every real access token carries it (see auth/tokens.js).
    sv: 0,
    ...overrides
  };
  return signAccessToken(payload, options);
}

// ── Express app factories ───────────────────────────────────────────────────

/**
 * Create a test Express app with JSON parsing and a user injected into req.
 * @param {string} routePath - Route prefix (e.g. "/api/v1/jobs")
 * @param {Function} routeHandler - Router factory function
 * @param {object} [user] - User to inject (defaults to createMockUser())
 */
export function makeTestApp(routePath, routeHandler, user) {
  const app = express();
  app.use(express.json());
  if (user !== null) {
    app.use((req, _res, next) => {
      req.user = user || createMockUser();
      next();
    });
  }
  app.use(routePath, typeof routeHandler === "function" ? routeHandler() : routeHandler);
  return app;
}

// ── Mock service factories ──────────────────────────────────────────────────

export function createMockLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn()
  };
}

export function createMockLimitsService() {
  return {
    getDeployment: vi.fn().mockReturnValue("local"),
    getLimits: vi.fn().mockReturnValue({
      teamMembers: -1,
      loadsPerMonth: -1,
      entitiesPerJob: -1,
      connections: -1
    })
  };
}

/** Returns the `name=value` pair of a Set-Cookie header from a supertest response. */
export function cookiePair(res, name) {
  const header = (res.headers["set-cookie"] || []).find((c) => c.startsWith(`${name}=`));
  return header ? header.split(";")[0] : null;
}

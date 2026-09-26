import express from "express";
import compression from "compression";
import cors from "cors";
import passport from "passport";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { buildPublicConfig } from "./public-config.js";
import { mountFrontend } from "./frontend.js";
import { logger } from "./logger.js";
import {
  applyTrustProxy,
  buildContentSecurityPolicy,
  createHttpLogger,
  requestIdMiddleware
} from "./http/setup.js";

import { authRoutes } from "./routes/auth.js";
import { connectionRoutes } from "./routes/connections.js";
import { jobRoutes } from "./routes/jobs.js";
import { teamRoutes } from "./routes/teams.js";
import { templateRoutes } from "./routes/templates.js";
import { setupRoutes } from "./routes/setup.js";
import { adminRoutes } from "./routes/admin/index.js";
import { errorHandler } from "./middleware/error-handler.js";
import { rateLimiter } from "./middleware/rate-limiter.js";
import { localRequestGuards } from "./local/guards.js";
import { query } from "./db/pool.js";

/**
 * Builds the Express app (API, health check, static frontend). It does not listen, start the job
 * runner or touch the database; start.js does that after migrations.
 */
export function createApp() {
  const app = express();
  const local = config.deployment === "local";

  // ── Local mode: refuse other sites and rebound hostnames before anything else ───────────
  // There is no sign-in in local mode, so these guards are what keeps a page open in the same
  // browser from using the API (see local/guards.js).
  if (local) {
    app.use(localRequestGuards({ port: config.port, appUrl: config.appUrl }));
  }

  // ── Proxy trust ─────────────────────────────────────────────────────────────
  // Behind Cloudflare + nginx set TRUST_PROXY (e.g. `1` or `loopback`) so req.ip — and with it
  // every per-IP rate limit — is the real client, not the proxy.
  applyTrustProxy(app, config.trustProxy);

  // ── Security headers ────────────────────────────────────────────────────────
  app.disable("x-powered-by");
  const contentSecurityPolicy = buildContentSecurityPolicy({
    sentryDsns: [process.env.SENTRY_DSN_FRONTEND, process.env.SENTRY_DSN]
  });
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "0");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    if (config.nodeEnv === "production") {
      res.setHeader("Content-Security-Policy", contentSecurityPolicy);
    }
    next();
  });

  // Local mode sends no CORS headers at all, so a browser never lets another origin read a
  // response or send the X-EasyTestData header (its preflight is never granted).
  if (!local) app.use(cors({ origin: config.allowedOrigins, credentials: true }));
  // No rate limit in local mode: every request comes from 127.0.0.1, so a cross-site page firing
  // <img> GETs could use up the one shared bucket and lock the real UI out.
  if (!local) app.use(rateLimiter());
  if (!local) app.use(passport.initialize());

  // ── Request ID ──────────────────────────────────────────────────────────────
  app.use(requestIdMiddleware());

  // ── Request logging (credentials redacted, query strings stripped) ─────────
  app.use(createHttpLogger(logger, { verbose: config.nodeEnv === "production" }));

  app.use(compression());
  app.use(express.json());

  // ── Health check ────────────────────────────────────────────────────────────
  // Public and minimal: only {status}. Uptime, memory and jobs by status are on the admin Overview
  // (GET /api/v1/admin/dashboard).
  app.get("/health", async (_req, res) => {
    try {
      await query("SELECT 1");
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "error" });
    }
  });

  // ── Public config (non-secret) ──────────────────────────────────────────────
  app.get("/api/v1/config/public", async (_req, res, next) => {
    try {
      res.json(await buildPublicConfig());
    } catch (err) {
      next(err);
    }
  });

  // ── API v1 routes ───────────────────────────────────────────────────────────
  // Local mode has one built-in user and team: no sign-in, teams, invites or admin area.
  app.use("/api/v1/auth", authRoutes({ local }));
  app.use("/api/v1/connections", connectionRoutes());
  app.use("/api/v1/jobs", jobRoutes());
  if (!local) app.use("/api/v1/teams", teamRoutes());
  app.use("/api/v1/templates", templateRoutes());
  // First-run Intuit keys setup; Cloud reads the keys from the environment only.
  if (local) app.use("/api/v1/setup", setupRoutes());
  if (!local) app.use("/api/v1/admin", adminRoutes());

  // ── Static files + SPA fallback ─────────────────────────────────────────────
  // The built web app: the workspace's packages/web/dist when it exists (so a leftover web-dist
  // never shadows a fresh build), else web-dist inside the published package (copied by prepack).
  const workspace = fileURLToPath(new URL("../../web/dist", import.meta.url));
  const webDistDir = existsSync(workspace)
    ? workspace
    : fileURLToPath(new URL("../web-dist", import.meta.url));
  logger.info({ webDistDir }, "Serving web UI");
  mountFrontend(app, { webDistDir });

  app.use(errorHandler);
  return app;
}

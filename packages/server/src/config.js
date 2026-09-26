import { homedir } from "node:os";
import { join } from "node:path";
import { DEPLOYMENT_LIMITS } from "@easytestdata/shared/constants";
import { isLoopbackUrl } from "./startup-checks.js";

// "cloud" (pg at DATABASE_URL, sign-in, abuse limits) or "local" (embedded PGlite in dataDir, one
// built-in user, loopback only). Normalized like startup-checks.js, which refuses anything else.
const deployment =
  (process.env.DEPLOYMENT || "").trim().toLowerCase() ||
  (process.env.DATABASE_URL ? "cloud" : "local");
const isLocal = deployment === "local";
const port = Number(process.env.PORT || (isLocal ? 28080 : 3000));
// Local: the browser-facing URL is the app itself, except in development, where the Vite dev
// server (LOCAL_PUBLIC_URL=http://localhost:5173, set only by the server's dev script) proxies
// /api, so the Intuit redirect and the OAuth popup share the page's origin. Only a localhost URL
// is accepted (startup-checks.js warns about any other).
const localPublicUrl = isLoopbackUrl(process.env.LOCAL_PUBLIC_URL)
  ? process.env.LOCAL_PUBLIC_URL
  : null;
const appUrl = (
  isLocal
    ? localPublicUrl || `http://localhost:${port}`
    : process.env.APP_URL || `http://localhost:${port}`
).replace(/\/+$/, "");

function positiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Parses TRUST_PROXY into an Express "trust proxy" setting. Unset/"false" trusts nothing (req.ip
 * is the socket peer); a number trusts that many hops (e.g. `1` behind one nginx); anything else
 * is passed through as an address/subnet list or preset (e.g. `loopback`, `10.0.0.0/8`).
 */
export function parseTrustProxy(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.toLowerCase() === "false" || raw === "0") return false;
  if (raw.toLowerCase() === "true") return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export const config = {
  deployment,
  port,
  // Local mode listens on loopback only; there is no option to bind elsewhere.
  host: isLocal ? "127.0.0.1" : process.env.HOST || "0.0.0.0",
  nodeEnv: process.env.NODE_ENV || "development",
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  dataDir: process.env.EASYTESTDATA_DATA_DIR || join(homedir(), ".easytestdata"),

  database: {
    url: process.env.DATABASE_URL || ""
  },

  // In local mode, start.js fills in the JWT secret and the token-encryption key from
  // local/secrets.js (dataDir/secret.key) when these variables are unset.
  jwt: {
    secret: process.env.JWT_SECRET || "change-me-to-a-random-64-char-string",
    issuer: process.env.JWT_ISSUER || "easytestdata",
    accessTokenExpiry: "15m"
  },

  tokenEncryption: {
    key: process.env.TOKEN_ENCRYPTION_KEY || "generate-with-openssl-rand-hex-32"
  },

  oauth: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET
    },
    intuit: {
      clientId: process.env.INTUIT_SSO_CLIENT_ID,
      clientSecret: process.env.INTUIT_SSO_CLIENT_SECRET
    }
  },

  // The Intuit app keys from the environment, read when used. Code that needs keys calls
  // services/app-settings.js getQboCredentials(), which falls back to keys saved in local setup.
  qbo: {
    get clientId() {
      return process.env.QBO_CLIENT_ID;
    },
    get clientSecret() {
      return process.env.QBO_CLIENT_SECRET;
    },
    // Must be registered as a Redirect URI in the Intuit developer app (sandbox keys).
    redirectUri: `${appUrl}/api/v1/connections/callback`
  },

  tokens: {
    oauthCodeTtlSec: 120, // 2 minutes
    teamInviteTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000 // 30 days
  },

  jobs: {
    // Parallel QBO jobs across teams (each team has at most one active QBO job, and the
    // per-connection lock serializes access to a single sandbox).
    qboConcurrency: positiveInt(process.env.QBO_WORKER_CONCURRENCY, 6),
    // Parallel generate/export jobs.
    localConcurrency: 5,
    // How often the job runner looks for pending jobs (it is also woken when one is queued).
    pollMs: 1000,
    qboTimeoutMs: positiveInt(process.env.QBO_JOB_TIMEOUT_MINUTES, 60) * 60 * 1000,
    localTimeoutMs: positiveInt(process.env.LOCAL_JOB_TIMEOUT_MINUTES, 15) * 60 * 1000,
    artifactTtlDays: positiveInt(process.env.JOB_ARTIFACT_TTL_DAYS, 7),
    // How often a running job checks whether it was cancelled.
    cancelPollMs: 2000,
    // After a timeout aborts a job, how long the worker waits for the job's own error path to
    // write its ledger/status and release the connection lock before failing it outright.
    timeoutGraceMs: positiveInt(process.env.JOB_TIMEOUT_GRACE_SECONDS, 60) * 1000,
    // How long a starting QBO job waits for the connection lock (a previous job may be
    // releasing it).
    lockWaitMs: 15_000
  },

  rateLimit: {
    windowSec: 60,
    authWindowSec: 15 * 60,
    ipLimit: 300,
    authLimit: 20
  },

  // Comma-separated, case-insensitive emails granted users.is_admin (see admin-bootstrap.js).
  adminEmails: (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),

  appUrl,
  marketingUrl: (process.env.MARKETING_URL || "https://easytestdata.com").replace(/\/+$/, ""),
  // Cloud CORS allowlist; local mode allows no cross-origin requests at all (server.js).
  allowedOrigins: (
    process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:5173"
  ).split(","),

  // Abuse limits by deployment (cloud vs local); see services/limits.js.
  limits: DEPLOYMENT_LIMITS
};

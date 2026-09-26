// Configuration checks that must pass before the server starts. Kept free of side effects so
// they can be unit-tested; start.js logs the problems and exits on any fatal one.

const CORE_REQUIRED = ["DATABASE_URL", "JWT_SECRET", "TOKEN_ENCRYPTION_KEY", "APP_URL"];
const DEFAULT_JWT_SECRET = "change-me-to-a-random-64-char-string";
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * True for an http(s) URL on localhost or 127.0.0.1: the only public address local mode accepts
 * from LOCAL_PUBLIC_URL (the Vite dev server). Anything else is ignored (config.js) with a warning.
 */
export function isLoopbackUrl(value) {
  try {
    const url = new URL(String(value));
    return (
      ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function checkSecrets(env, fatal) {
  if (env.JWT_SECRET === DEFAULT_JWT_SECRET) {
    fatal.push("JWT_SECRET must be changed from the default value");
  } else if (env.JWT_SECRET && env.JWT_SECRET.length < MIN_JWT_SECRET_LENGTH) {
    fatal.push(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters`);
  }
  if (env.TOKEN_ENCRYPTION_KEY && !/^[a-fA-F0-9]{64}$/.test(env.TOKEN_ENCRYPTION_KEY)) {
    fatal.push("TOKEN_ENCRYPTION_KEY must be a 64-char hex string (openssl rand -hex 32)");
  }
}

/**
 * Returns { fatal: string[], warnings: string[] } for the given environment. DEPLOYMENT must be
 * "cloud" or "local" (unset: cloud when DATABASE_URL is set, else local, as in config.js). A Cloud
 * production server needs its configuration; local mode makes its own secrets, but validates any
 * given in the environment, and is only chosen implicitly where nothing suggests a Cloud server.
 */
export function collectStartupProblems(env = process.env) {
  const fatal = [];
  const warnings = [];
  const explicit = (env.DEPLOYMENT || "").trim().toLowerCase();
  const deployment = explicit || (env.DATABASE_URL ? "cloud" : "local");

  if (!["cloud", "local"].includes(deployment)) {
    fatal.push(`DEPLOYMENT must be "cloud" or "local" (got "${env.DEPLOYMENT}")`);
    return { fatal, warnings };
  }

  if (deployment === "local") {
    // A Cloud server that lost DATABASE_URL must not quietly become the no-login local app.
    if (!explicit && (env.NODE_ENV === "production" || env.TRUST_PROXY || env.APP_URL)) {
      fatal.push("Set DEPLOYMENT=cloud with DATABASE_URL, or DEPLOYMENT=local");
      return { fatal, warnings };
    }
    checkSecrets(env, fatal);
    if (env.LOCAL_PUBLIC_URL && !isLoopbackUrl(env.LOCAL_PUBLIC_URL)) {
      warnings.push(
        `LOCAL_PUBLIC_URL ignored: it must be on localhost or 127.0.0.1 (got "${env.LOCAL_PUBLIC_URL}")`
      );
    }
    return { fatal, warnings };
  }

  if (env.NODE_ENV === "production") {
    const missing = CORE_REQUIRED.filter((key) => !env[key]);
    if (missing.length > 0) {
      fatal.push(`Missing required env vars: ${missing.join(", ")}`);
    }
    checkSecrets(env, fatal);
    const missingOAuth = [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET"
    ].filter((key) => !env[key]);
    if (missingOAuth.length > 0) {
      warnings.push(
        `Missing env vars — some OAuth login providers will be unavailable: ${missingOAuth.join(", ")}`
      );
    }
  }

  return { fatal, warnings };
}

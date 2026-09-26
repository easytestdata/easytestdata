import { readFileSync } from "node:fs";
import { config } from "./config.js";
import { getQboCredentials } from "./services/app-settings.js";

const OAUTH_PROVIDERS = ["google", "github", "intuit"];

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return pkg.version || null;
  } catch {
    return null;
  }
}

const version = readVersion();

/**
 * Non-secret configuration the web UI needs before login. Served at /api/v1/config/public.
 */
export async function buildPublicConfig() {
  const enabledOAuthProviders = OAUTH_PROVIDERS.filter((p) => {
    const creds = config.oauth[p];
    return creds && creds.clientId && creds.clientSecret;
  });
  return {
    version,
    sentryDsn: process.env.SENTRY_DSN_FRONTEND || null,
    deployment: config.deployment,
    enabledOAuthProviders,
    qboConfigured: Boolean(await getQboCredentials()),
    qboRedirectUri: config.qbo.redirectUri,
    // The marketing site and its legal pages (Terms, Privacy) are hosted apart from the app.
    marketingUrl: config.marketingUrl
  };
}

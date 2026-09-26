import { config } from "../config.js";
import { decryptValue, encryptValue } from "../crypto/tokens.js";
import { query } from "../db/pool.js";
import { logger } from "../logger.js";
import { AppError, ErrorCode } from "../errors.js";

const QBO_CREDENTIALS_KEY = "qbo_credentials";
// Every page load and job reads the keys, so the "could not be read" warning is logged once.
let warnedUnreadableKeys = false;

/**
 * The Intuit developer app keys used to connect and refresh QBO sandboxes, or null when none are
 * set. QBO_CLIENT_ID / QBO_CLIENT_SECRET win; otherwise (local mode only, where the first-run
 * setup page saves them) the keys stored in app_settings. Read on every call, never cached, so
 * keys saved in setup apply at once. Cloud only reads the environment: nothing writes the table
 * there. Stored keys that no longer decrypt (the encryption key changed) count as not configured,
 * so the app keeps working and the setup page can overwrite them.
 */
export async function getQboCredentials() {
  const { clientId, clientSecret } = config.qbo;
  if (clientId && clientSecret) return { clientId, clientSecret };
  if (config.deployment !== "local") return null;

  const result = await query("SELECT value_enc, iv FROM app_settings WHERE key = $1", [
    QBO_CREDENTIALS_KEY
  ]);
  const row = result.rows[0];
  if (!row) return null;
  try {
    const stored = JSON.parse(decryptValue(row.value_enc, row.iv));
    if (stored?.clientId && stored?.clientSecret) {
      return { clientId: stored.clientId, clientSecret: stored.clientSecret };
    }
  } catch {
    // Fall through: no values (and no error details) are logged.
  }
  if (!warnedUnreadableKeys) {
    warnedUnreadableKeys = true;
    logger.warn(
      "Stored Intuit keys could not be read (encryption key changed?); re-enter them on the setup page"
    );
  }
  return null;
}

/** Stores the Intuit app keys encrypted (with TOKEN_ENCRYPTION_KEY), replacing any saved before. */
export async function saveQboCredentials({ clientId, clientSecret }) {
  const { value_enc, iv } = encryptValue(JSON.stringify({ clientId, clientSecret }));
  await query(
    `INSERT INTO app_settings (key, value_enc, iv, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value_enc = EXCLUDED.value_enc, iv = EXCLUDED.iv, updated_at = NOW()`,
    [QBO_CREDENTIALS_KEY, value_enc, iv]
  );
}

/** 503 for anything that needs the Intuit app keys while none are set. */
export function qboNotConfiguredError() {
  const where =
    config.deployment === "local"
      ? "Add your Intuit developer app's keys on the setup page"
      : "Set QBO_CLIENT_ID and QBO_CLIENT_SECRET from your Intuit developer app";
  return new AppError(
    503,
    ErrorCode.QBO_NOT_CONFIGURED,
    `QuickBooks Online is not configured on this server. ${where} and register ` +
      `${config.qbo.redirectUri} as its redirect URI.`
  );
}

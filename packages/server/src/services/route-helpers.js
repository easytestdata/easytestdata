import crypto from "crypto";

/**
 * Normalize an email address: lowercase + trim.
 */
export function normalizeEmail(email) {
  return String(email || "")
    .toLowerCase()
    .trim();
}

/**
 * Extract the first row from a query result, or throw a 404-able error.
 *
 * Usage:
 *   const scenario = requireRow(result, "Scenario");
 *   // throws HttpError(404) if no rows
 */
export function requireRow(result, label = "Resource") {
  const row = result.rows?.[0];
  if (!row) {
    const err = new Error(`${label} not found`);
    err.status = 404;
    throw err;
  }
  return row;
}

/**
 * Generate a cryptographically secure random token and its SHA-256 hash.
 */
export function generateHashedToken(byteLength = 32) {
  const raw = crypto.randomBytes(byteLength).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

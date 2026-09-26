import { config } from "../config.js";
import { query } from "../db/pool.js";
import { logger } from "../logger.js";

// Admin bootstrap: users whose email is in ADMIN_EMAILS (comma-separated, case-insensitive) get
// users.is_admin at sign-in and at startup. Every stored email was verified by the sign-in
// provider (upsertOAuthUser refuses unverified ones), so a listed address cannot be claimed by
// someone who does not control it.

export function isBootstrapAdminEmail(email) {
  const normalized = String(email || "")
    .trim()
    .toLowerCase();
  return normalized.length > 0 && config.adminEmails.includes(normalized);
}

export async function grantAdmin(userId, db = { query }) {
  await db.query("UPDATE users SET is_admin = true WHERE id = $1 AND is_admin = false", [userId]);
}

/** Makes `user` ({ id, email }) an admin when its email is in ADMIN_EMAILS. */
export async function applyAdminBootstrap(user) {
  if (!user?.id || !isBootstrapAdminEmail(user.email)) return false;
  try {
    await grantAdmin(user.id);
    return true;
  } catch (err) {
    logger.error({ err, userId: user.id }, "Failed to apply ADMIN_EMAILS bootstrap");
    return false;
  }
}

/** Startup: makes existing users listed in ADMIN_EMAILS admins. */
export async function bootstrapAdminsAtStartup() {
  if (config.adminEmails.length === 0) return 0;
  const result = await query("SELECT id, email FROM users WHERE LOWER(email) = ANY($1::text[])", [
    config.adminEmails
  ]);
  for (const user of result.rows) {
    await grantAdmin(user.id);
  }
  if (result.rows.length > 0) {
    logger.info({ count: result.rows.length }, "ADMIN_EMAILS bootstrap applied");
  }
  return result.rows.length;
}

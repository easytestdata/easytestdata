import { logger } from "../logger.js";
import { query } from "../db/pool.js";
import { withLockedConnection, ConnectionLockBusyError } from "../services/connection-lock.js";
import { getQboCredentials } from "../services/app-settings.js";

const REFRESH_THRESHOLD_DAYS = 14;
const TOKEN_EXPIRY_DAYS = 100;
const BUSY_RETRY_BACKOFF_MS = 5000;

/** Resolves after `ms`, or as soon as `signal` aborts. */
function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Proactive token refresh job. Runs daily (and once at startup) to refresh QBO tokens that are
 * approaching expiry (within REFRESH_THRESHOLD_DAYS of the 100-day expiry window).
 * `busyRetryDelayMs` is injectable for tests.
 *
 * `signal` (the job runner's, aborted when it stops): once it aborts, no further connection is
 * refreshed (the rest count as skipped) and the busy back-off ends at once. A refresh already sent
 * to Intuit is left to finish and persist: the rotated refresh token would otherwise be lost. So
 * after the abort the run ends within one Intuit call, before the database closes.
 */
export async function refreshExpiringTokens({
  busyRetryDelayMs = BUSY_RETRY_BACKOFF_MS,
  signal = null
} = {}) {
  // Without the Intuit app keys no token can be refreshed: skip the run instead of failing each.
  if (!(await getQboCredentials())) {
    logger.info("Token refresh: skipped, QuickBooks Online is not configured");
    return { refreshed: 0, failed: 0, skipped: 0 };
  }

  const thresholdDays = TOKEN_EXPIRY_DAYS - REFRESH_THRESHOLD_DAYS;
  const result = await query(
    `SELECT id, realm_id, company_name, access_token_enc, refresh_token_enc, token_iv, base_url,
            COALESCE(last_used_at, connected_at) AS last_activity
     FROM qbo_connections
     WHERE disconnected_at IS NULL
       AND COALESCE(last_used_at, connected_at) < NOW() - INTERVAL '${thresholdDays} days'
       AND COALESCE(last_used_at, connected_at) > NOW() - INTERVAL '${TOKEN_EXPIRY_DAYS} days'`
  );

  if (result.rows.length === 0) {
    logger.info("Token refresh: no connections need refreshing");
    return { refreshed: 0, failed: 0, skipped: 0 };
  }

  logger.info({ count: result.rows.length }, "Token refresh: found connections to refresh");

  // Refresh one connection under its lock. Serializing through the shared
  // per-connection lock (with a compare-and-swap on the persisted token) means
  // this keepalive cannot race an in-flight job/health refresh and rotate the
  // refresh token out from under it. Returns "refreshed" | "busy" | "failed".
  async function refreshOne(conn) {
    try {
      // withLockedConnection re-reads the row under the lock, so a retry (or the
      // first pass) uses whatever token a previous holder just persisted rather
      // than the possibly-stale token from the upfront SELECT.
      await withLockedConnection(conn.id, async ({ client, conn: fresh }) => {
        // Force the refresh: a freshly built client treats its stored access token as new, so
        // ensureAccessToken() would return it without ever contacting Intuit.
        const refreshTokenBefore = client.refreshToken;
        await client.refreshAccessToken();
        if (client.refreshToken !== refreshTokenBefore) {
          // Rotated: the client's compare-and-swap callback persisted it (and last_used_at).
          // That callback cannot fail the refresh, so confirm the stored token moved on.
          const after = await query("SELECT refresh_token_enc FROM qbo_connections WHERE id = $1", [
            conn.id
          ]);
          if (after.rows[0]?.refresh_token_enc === fresh.refresh_token_enc) {
            throw new Error("Rotated refresh token was not persisted");
          }
        } else {
          // Intuit kept the same refresh token and extended it: record the activity so the
          // connection is not treated as idle (and eventually dropped from this keepalive).
          await query(
            `UPDATE qbo_connections SET last_used_at = NOW()
             WHERE id = $1 AND refresh_token_enc = $2`,
            [conn.id, fresh.refresh_token_enc]
          );
        }
      });
      logger.info(
        { connectionId: conn.id, company: conn.company_name },
        "Token refreshed successfully"
      );
      return "refreshed";
    } catch (err) {
      if (err instanceof ConnectionLockBusyError) return "busy";
      logger.error(
        { err, connectionId: conn.id, company: conn.company_name },
        "Token refresh failed"
      );
      return "failed";
    }
  }

  let refreshed = 0;
  let failed = 0;
  let skipped = 0;
  const busy = [];

  for (const conn of result.rows) {
    if (signal?.aborted) {
      skipped++;
      continue;
    }
    const outcome = await refreshOne(conn);
    if (outcome === "refreshed") refreshed++;
    else if (outcome === "failed") failed++;
    else busy.push(conn);
  }

  // A short-lived holder (e.g. /connections/:id/test) likely releases within a
  // few seconds. Back off, then retry busy connections once so a near-expiry
  // connection does not miss its keepalive for the whole daily run; only give up
  // if it is still in use after the backoff.
  if (busy.length > 0 && busyRetryDelayMs > 0) {
    await wait(busyRetryDelayMs, signal);
  }
  for (const conn of busy) {
    if (signal?.aborted) {
      skipped++;
      continue;
    }
    const outcome = await refreshOne(conn);
    if (outcome === "refreshed") refreshed++;
    else if (outcome === "failed") failed++;
    else {
      skipped++;
      logger.info(
        { connectionId: conn.id, company: conn.company_name },
        "Token refresh skipped — connection still in use after retry"
      );
    }
  }

  if (signal?.aborted && skipped > 0) {
    logger.warn({ skipped }, "Token refresh stopped early: the server is shutting down");
  }
  logger.info({ refreshed, failed, skipped }, "Token refresh complete");
  return { refreshed, failed, skipped };
}

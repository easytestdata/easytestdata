import crypto from "crypto";
import { QboClient } from "@easytestdata/qbo-client";
import { logger } from "../logger.js";
import { decryptTokenPair, encryptTokenPair } from "../crypto/tokens.js";
import { query } from "../db/pool.js";
import { getQboCredentials, qboNotConfiguredError } from "./app-settings.js";

/**
 * Thrown when a per-connection lock is already held by another operation.
 * Callers decide how to react (HTTP 409, skip, etc.) instead of treating it
 * as a generic failure.
 */
export class ConnectionLockBusyError extends Error {
  constructor(connectionId) {
    super("Another operation is already running for this QBO connection.");
    this.name = "ConnectionLockBusyError";
    this.connectionId = connectionId;
    this.busy = true;
  }
}

/** Shown when a job, test or health check reaches a sandbox the team has disconnected. */
export const SANDBOX_DISCONNECTED_MESSAGE =
  "This QuickBooks sandbox is disconnected. Reconnect it to use it again.";

// connectionId -> token of the current holder. One process runs every job, so an in-memory map
// serializes access; holders release in `finally`, so there is no TTL or heartbeat.
const heldLocks = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the per-connection lock that serializes all QBO access — token refresh included —
 * against a single connection. With `waitMs`, retries for that long before giving up (a previous
 * job may be releasing it). Throws {@link ConnectionLockBusyError} if the lock is still held.
 */
export async function acquireConnectionLock(connectionId, options = {}) {
  if (!connectionId) return null;

  const { waitMs = 0, retryDelayMs = 500 } = options;
  const deadline = Date.now() + waitMs;
  while (heldLocks.has(connectionId)) {
    if (Date.now() >= deadline) throw new ConnectionLockBusyError(connectionId);
    await sleep(retryDelayMs);
  }
  const token = crypto.randomBytes(16).toString("hex");
  heldLocks.set(connectionId, token);
  return { connectionId, token };
}

/** Releases a lock, only while `lock` still owns it. */
export async function releaseConnectionLock(lock) {
  if (!lock) return;
  if (heldLocks.get(lock.connectionId) === lock.token) heldLocks.delete(lock.connectionId);
}

/**
 * Run `fn` while holding the per-connection lock, releasing it afterwards even
 * if `fn` throws. This is the single funnel every QBO-token-refreshing path
 * goes through so concurrent refreshes on one connection cannot race and
 * rotate the refresh token out from under each other.
 */
export async function withConnectionLock(connectionId, fn) {
  const lock = await acquireConnectionLock(connectionId);
  try {
    return await fn();
  } finally {
    await releaseConnectionLock(lock);
  }
}

/**
 * Acquire the connection lock, RE-READ the connection row while holding it, and
 * run `fn({ client, conn })` with a locked client built from that fresh row.
 * Throws a 503 QBO_NOT_CONFIGURED AppError when no Intuit app keys are set.
 *
 * Re-reading under the lock is what makes the client correct: a previous holder
 * may have rotated and persisted a new refresh token between the caller's own
 * SELECT and this lock, and the QBO refresh token is single-use. Building from a
 * pre-lock row would use a now-revoked token (or CAS-miss on persist). Throws if
 * the connection no longer exists. Propagates ConnectionLockBusyError if the
 * lock is held.
 */
export async function withLockedConnection(connectionId, fn) {
  const credentials = await getQboCredentials();
  if (!credentials) throw qboNotConfiguredError();
  return withConnectionLock(connectionId, async () => {
    const result = await query("SELECT * FROM qbo_connections WHERE id = $1", [connectionId]);
    if (result.rows.length === 0) {
      throw new Error("QBO connection not found");
    }
    const conn = result.rows[0];
    const client = buildLockedQboClient(conn, credentials);
    return fn({ client, conn });
  });
}

/**
 * Build a QboClient whose token refresh is persisted with a compare-and-swap
 * on the refresh-token ciphertext read when the client was built. If another
 * writer (e.g. an OAuth reconnect that does not take this lock) has rotated the
 * token in the meantime, the CAS matches zero rows and we skip the write rather
 * than clobber the newer token with one derived from a now-stale refresh token.
 *
 * Callers MUST build the client and drive it inside {@link withConnectionLock}
 * so refreshes on the same connection are serialized. `credentials` are the Intuit app keys
 * from getQboCredentials() (services/app-settings.js). A job passes its `signal`: the client then
 * starts no QBO request once the job is cancelled, timed out or shut down (QboClient's `signal`).
 */
export function buildLockedQboClient(conn, credentials, { signal } = {}) {
  // A disconnected sandbox has no tokens; every QBO path builds its client here.
  if (conn.disconnected_at) throw new Error(SANDBOX_DISCONNECTED_MESSAGE);
  const tokens = decryptTokenPair(conn.access_token_enc, conn.refresh_token_enc, conn.token_iv);
  // Advances after every successful persist so repeated refreshes by this same
  // lock holder (e.g. a long job that crosses a second access-token window)
  // keep matching the CAS guard instead of colliding with their own prior write.
  let expectedRefreshTokenEnc = conn.refresh_token_enc;

  return new QboClient({
    qboClientId: credentials.clientId,
    qboClientSecret: credentials.clientSecret,
    qboRefreshToken: tokens.refreshToken,
    qboAccessToken: tokens.accessToken,
    qboRealmId: conn.realm_id,
    qboBaseUrl: conn.base_url,
    qboMinorVersion: "65",
    signal,
    onTokenRefresh: async ({ accessToken, refreshToken }) => {
      const updated = encryptTokenPair(accessToken, refreshToken);
      const result = await query(
        `UPDATE qbo_connections
         SET access_token_enc = $1, refresh_token_enc = $2, token_iv = $3, last_used_at = NOW()
         WHERE id = $4 AND refresh_token_enc = $5`,
        [
          updated.access_token_enc,
          updated.refresh_token_enc,
          updated.token_iv,
          conn.id,
          expectedRefreshTokenEnc
        ]
      );
      if (result.rowCount === 0) {
        logger.warn(
          { connectionId: conn.id },
          "QBO token refresh not persisted — connection was updated concurrently (CAS miss)"
        );
        return;
      }
      expectedRefreshTokenEnc = updated.refresh_token_enc;
    }
  });
}

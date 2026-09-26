import { transaction } from "../db/pool.js";
import {
  acquireConnectionLock,
  releaseConnectionLock,
  ConnectionLockBusyError
} from "./connection-lock.js";
import { hasActiveJob, lockConnection } from "./connection-guard.js";

/** The 409 text when a job or the lock is using the sandbox. */
export const DISCONNECT_BUSY_MESSAGE =
  "A job is queued or running on this sandbox. Wait for it to finish (or cancel it), then disconnect.";

/**
 * Disconnects a sandbox, keeping its row: clears the tokens and sets disconnected_at, so its jobs
 * keep their connection_id and a reconnect of the same realm reuses the row. Refused while a job
 * uses the connection (queued, running or stopping) or anything holds its in-process lock (a
 * connection test or the token keepalive): a running load would keep writing to QBO with its
 * already-built client. Follows services/connection-guard.js's rule (team row, then connection
 * row, then the check and the write), so a job insert and a disconnect never both succeed.
 * `teamId` scopes it to one team (the team route); the admin route passes none.
 *
 * Returns "disconnected", "busy", or "absent" (no connected row with that id).
 */
export async function disconnectConnection(connectionId, { teamId = null } = {}) {
  let lock;
  try {
    lock = await acquireConnectionLock(connectionId);
  } catch (err) {
    if (err instanceof ConnectionLockBusyError) return "busy";
    throw err;
  }
  try {
    return await transaction(async (client) => {
      const conn = await lockConnection(client, { connectionId, teamId });
      if (!conn || conn.disconnected_at) return "absent";
      if (await hasActiveJob(client, connectionId)) return "busy";
      await client.query(
        `UPDATE qbo_connections
         SET access_token_enc = NULL, refresh_token_enc = NULL, token_iv = NULL,
             disconnected_at = NOW()
         WHERE id = $1`,
        [connectionId]
      );
      return "disconnected";
    });
  } finally {
    await releaseConnectionLock(lock);
  }
}

import { AppError, ErrorCode } from "../errors.js";
import { SANDBOX_DISCONNECTED_MESSAGE } from "./connection-lock.js";

/**
 * The one rule for QBO connection state. Every write that depends on a qbo_connections row's
 * state (storing or reconnecting it at the OAuth callback, disconnecting it, and inserting a job
 * that will use it) runs inside transaction() and, before checking anything, locks in this order:
 *
 *   1. the team row          (lockTeam: SELECT ... FROM teams ... FOR NO KEY UPDATE)
 *   2. the connection row    (lockConnection / lockRealmConnection: ... FOR NO KEY UPDATE)
 *   3. membership rows, where the write acts for a user (lockConnectingMember: ... FOR SHARE)
 *
 * and only then reads the state it decides on (connected, busy, member) and writes. Two such
 * transactions on one connection therefore run one after the other: a disconnect and a job insert
 * can never both succeed, and a member removed while a callback is in flight either waits for the
 * store or makes it refuse. Always the same order, so they never deadlock with each other.
 *
 * FOR NO KEY UPDATE (not FOR UPDATE): it excludes every other writer of the row, but not the
 * KEY SHARE lock a foreign-key check takes (e.g. inserting a job or a membership that references
 * the team), so an insert elsewhere never waits on, or cycles with, these locks. The users row is
 * never locked here: session issuance and revocation lock it first (lockSessionVersion, also FOR
 * NO KEY UPDATE), and a job insert only takes its foreign-key KEY SHARE, which does not conflict.
 *
 * Single-statement writes that decide in their own WHERE clause (the token compare-and-swap in
 * connection-lock.js, last_used_at stamps) are atomic on their own and do not need the rule.
 */

/** Locks the team row (step 1). */
export async function lockTeam(client, teamId) {
  await client.query("SELECT id FROM teams WHERE id = $1 FOR NO KEY UPDATE", [teamId]);
}

/**
 * Locks the team row, then the connection row (steps 1-2) and returns the row, or null when there
 * is no such connection (in that team, when `teamId` is given). Without `teamId` (admin routes)
 * the owning team is looked up first; a connection never changes team, so that read needs no lock.
 */
export async function lockConnection(client, { connectionId, teamId = null }) {
  let team = teamId;
  if (!team) {
    const owner = await client.query("SELECT team_id FROM qbo_connections WHERE id = $1", [
      connectionId
    ]);
    team = owner.rows[0]?.team_id;
    if (!team) return null;
  }
  await lockTeam(client, team);
  const { rows } = await client.query(
    "SELECT * FROM qbo_connections WHERE id = $1 AND team_id = $2 FOR NO KEY UPDATE",
    [connectionId, team]
  );
  return rows[0] || null;
}

/** Steps 1-2 for the OAuth callback, which knows the realm rather than the row id. */
export async function lockRealmConnection(client, { teamId, realmId }) {
  await lockTeam(client, teamId);
  const { rows } = await client.query(
    "SELECT * FROM qbo_connections WHERE team_id = $1 AND realm_id = $2 FOR NO KEY UPDATE",
    [teamId, realmId]
  );
  return rows[0] || null;
}

/**
 * Step 3: whether `userId` is still an unsuspended member of `teamId`. FOR SHARE OF tm holds the
 * membership row until commit, so a concurrent removal waits for this transaction, and one that
 * committed first makes this return false. The users row is read, not locked: locking it would put
 * a users-row lock after the team lock, the reverse of the session paths (users row first), and
 * a suspension only needs to be seen, not serialized (a suspended user can use nothing anyway).
 */
export async function lockConnectingMember(client, { teamId, userId }) {
  const { rows } = await client.query(
    `SELECT 1 FROM team_members tm JOIN users u ON u.id = tm.user_id
     WHERE tm.team_id = $1 AND tm.user_id = $2 AND u.suspended_at IS NULL
     FOR SHARE OF tm`,
    [teamId, userId]
  );
  return rows.length > 0;
}

/** Whether a job still uses (or is about to use) the connection: queued, running or stopping. */
export async function hasActiveJob(client, connectionId) {
  const { rows } = await client.query(
    `SELECT 1 FROM jobs
     WHERE connection_id = $1 AND status IN ('pending', 'running', 'cancelling')
     LIMIT 1`,
    [connectionId]
  );
  return rows.length > 0;
}

/** 404 for a missing connection, 409 for a disconnected one; the row otherwise. */
export function requireUsableConnection(conn) {
  if (!conn) throw new AppError(404, ErrorCode.NOT_FOUND, "Connection not found");
  if (conn.disconnected_at) {
    throw new AppError(409, ErrorCode.CONFLICT, SANDBOX_DISCONNECTED_MESSAGE);
  }
  return conn;
}

import { AppError, ErrorCode } from "../errors.js";
import { transaction } from "../db/pool.js";
import { getLimits, limitExceededError } from "./limits.js";
import { lockConnection, lockTeam, requireUsableConnection } from "./connection-guard.js";

/**
 * Partial unique index jobs_one_active_qbo_job_per_team: one pending, running or cancelling
 * load/purge/rollback per team.
 */
export const ACTIVE_QBO_JOB_INDEX = "jobs_one_active_qbo_job_per_team";

export function isActiveQboJobConflict(err) {
  return err?.code === "23505" && err?.constraint === ACTIVE_QBO_JOB_INDEX;
}

export function activeQboJobConflictError() {
  return new AppError(
    409,
    ErrorCode.RESOURCE_BUSY,
    "A QuickBooks job is already queued or running for this team. Wait for it to finish (or cancel it) before starting another."
  );
}

/**
 * Inserts a job row: the one way every job is created. Follows services/connection-guard.js's
 * rule: in one transaction it locks the team row and, for a job that uses a sandbox, the
 * connection row, then refuses a missing (404) or disconnected (409) connection, runs `check`
 * (throw an AppError to refuse), applies the team's monthly load limit to a load (403), and inserts. The
 * one-active-QBO-job-per-team index maps to 409.
 *
 * The lock makes the checks and the insert atomic: a disconnect cannot land between them, and
 * two loads at 9 of 10 cannot both see 9 (the second waits for the first's commit).
 *
 * `check(client, connection)` runs under the locks for route-specific state (e.g. one rollback
 * per load, no retry of a load that still has orphans).
 */
export async function insertLimitedJob({
  teamId,
  connectionId = null,
  type,
  config = {},
  createdBy = null,
  parentJobId = null,
  check = null
}) {
  const limits = getLimits();
  try {
    return await transaction(async (client) => {
      let connection = null;
      if (connectionId) {
        connection = requireUsableConnection(
          await lockConnection(client, { connectionId, teamId })
        );
      } else {
        await lockTeam(client, teamId);
      }
      if (check) await check(client, connection);

      // Only loads into QuickBooks count: downloads, removals and roll backs never use it up.
      if (type === "load" && limits.loadsPerMonth !== -1) {
        const count = await client.query(
          `SELECT COUNT(*)::int AS count FROM jobs
           WHERE team_id = $1 AND type = 'load' AND created_at >= date_trunc('month', NOW())`,
          [teamId]
        );
        if (Number(count.rows[0]?.count || 0) >= limits.loadsPerMonth) {
          throw limitExceededError("loadsPerMonth", limits.loadsPerMonth);
        }
      }
      const inserted = await client.query(
        `INSERT INTO jobs (team_id, connection_id, type, config, created_by, parent_job_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [teamId, connectionId, type, JSON.stringify(config), createdBy, parentJobId]
      );
      return inserted.rows[0];
    });
  } catch (err) {
    if (isActiveQboJobConflict(err)) throw activeQboJobConflictError();
    throw err;
  }
}

/** The 409 text for re-running a load whose records are still in the sandbox. */
export const ORPHANS_REMAIN_MESSAGE =
  'This load left records in QuickBooks. Roll it back or use "Remove test data" first, then retry.';

/**
 * Refuses (409) to run a load's plan again while the records it created may still be in the
 * sandbox: the retry would create every transaction a second time (master data is reused,
 * transactions are not deduplicated). That is a load in failed_with_orphans (its ledger says
 * what it created) until it is rolled back (the rollback moves it to failed), and a load failed
 * at its timeout (`result.timedOut`: its work may have gone on after the job was failed). Either
 * is allowed again once a completed Remove test data on the same connection, started after it, removed
 * its tag (or everything), or when the retry clears them itself: its config's purgeMode is
 * "generated" (the same tag) or "all". Pass it as insertLimitedJob's `check`, so it is decided
 * under the locks. Other job types (a failed rollback can be retried) pass.
 *
 * Only replays are refused. A new load with the same explicit seed (the API accepts one) is a
 * deliberate second copy and is not.
 */
export async function refuseReplayOverOrphans(client, job) {
  if (job.type !== "load") return;
  const purgeMode = job.config?.purgeMode;
  if (purgeMode === "generated" || purgeMode === "all") return;
  const { rows } = await client.query(
    `SELECT 1 FROM jobs l
     WHERE l.id = $1
       AND (l.status = 'failed_with_orphans'
            OR (l.status = 'failed' AND l.result->>'timedOut' = 'true'))
       AND NOT EXISTS (
         SELECT 1 FROM jobs p
         WHERE p.connection_id = l.connection_id AND p.type = 'purge' AND p.status = 'completed'
           AND p.created_at > l.created_at
           AND (p.config->>'purgeMode' = 'all'
                OR UPPER(COALESCE(p.config->>'tag', 'EZTD')) = UPPER(COALESCE(l.config->>'tag', 'EZTD')))
       )`,
    [job.id]
  );
  if (rows.length > 0) throw new AppError(409, ErrorCode.CONFLICT, ORPHANS_REMAIN_MESSAGE);
}

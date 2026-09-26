import { query } from "../db/pool.js";

/**
 * Cancel a job. A pending job has not started, so it becomes 'cancelled' at once (the runner only
 * starts pending jobs, and its claim skips one that is no longer pending). A running job becomes
 * 'cancelling': the worker notices, stops at the next batch boundary and then sets 'cancelled'
 * (or 'failed_with_orphans' when a load had already created records). Until then the job keeps
 * the team's active QBO job slot.
 *
 * Returns the updated row, or null when the job does not exist (in that team) or is not active.
 */
export async function requestJobCancel(jobId, { teamId } = {}) {
  const params = [jobId];
  let teamFilter = "";
  if (teamId) {
    params.push(teamId);
    teamFilter = "AND team_id = $2";
  }
  const result = await query(
    `UPDATE jobs
     SET status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE 'cancelling' END,
         completed_at = CASE WHEN status = 'pending' THEN NOW() ELSE completed_at END
     WHERE id = $1 ${teamFilter} AND status IN ('pending', 'running')
     RETURNING *`,
    params
  );
  return result.rows[0] || null;
}

import { query } from "../db/pool.js";
import { EXTENSION_NAME } from "../extensions.js";
import { notifyJobQueued } from "../workers/runner.js";
import { insertLimitedJob } from "./job-enqueue.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Queues an extension job (see extension descriptors' `jobs`) through insertLimitedJob, so it
 * gets the connection guard (404 missing / 409 disconnected sandbox), the route's `check` under
 * the team and connection locks, and the one-active-QuickBooks-job-per-team rule (409). The
 * monthly load limit does not apply. Resolves to { id }.
 */
export async function enqueueExtensionJob({
  teamId,
  createdBy = null,
  connectionId = null,
  extension,
  kind,
  payload = {},
  check = null
}) {
  if (!EXTENSION_NAME.test(extension ?? "") || !EXTENSION_NAME.test(kind ?? "")) {
    throw new Error("enqueueExtensionJob needs a valid extension name and job kind");
  }
  const row = await insertLimitedJob({
    teamId,
    connectionId,
    type: "extension",
    config: { extension, kind, payload },
    createdBy,
    check
  });
  notifyJobQueued();
  return { id: row.id };
}

/** The team's extension job row, or null (not found, another team's, or not an extension job). */
export async function getExtensionJob(teamId, jobId) {
  if (!UUID.test(String(jobId))) return null;
  const { rows } = await query(
    "SELECT * FROM jobs WHERE id = $1 AND team_id = $2 AND type = 'extension'",
    [jobId, teamId]
  );
  return rows[0] ?? null;
}

/**
 * Cancels the team's extension job as POST /jobs/:id/cancel does (pending → cancelled, running →
 * cancelling). Returns the updated row, or null when it is not the team's active extension job.
 */
export async function cancelExtensionJob(teamId, jobId) {
  if (!UUID.test(String(jobId))) return null;
  const result = await query(
    `UPDATE jobs
     SET status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE 'cancelling' END,
         completed_at = CASE WHEN status = 'pending' THEN NOW() ELSE completed_at END
     WHERE id = $1 AND team_id = $2 AND type = 'extension' AND status IN ('pending', 'running')
     RETURNING *`,
    [jobId, teamId]
  );
  return result.rows[0] ?? null;
}

import { isUnlimited, limitExceededMessage } from "@easytestdata/shared/constants";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { AppError, ErrorCode } from "../errors.js";

/** "cloud" on EasyTestData Cloud, "local" in local mode (unlimited). */
export function getDeployment() {
  return config.deployment === "local" ? "local" : "cloud";
}

/** The abuse limits that apply to every team on this deployment (-1 = unlimited). */
export function getLimits() {
  return config.limits[getDeployment()];
}

/** 403 with the standard "EasyTestData Cloud allows up to N ... Run it locally ..." text. */
export function limitExceededError(kind, limit) {
  return new AppError(403, ErrorCode.LIMIT_EXCEEDED, limitExceededMessage(kind, limit));
}

/**
 * This month's loads for a team (counted the way the limit counts them: every load created this
 * month) and the records created or deleted by this month's completed jobs.
 */
export async function getMonthlyUsage(teamId) {
  const { rows } = await query(
    `SELECT COUNT(*) FILTER (WHERE type = 'load')::int AS loads,
            COALESCE(SUM(entity_count) FILTER (WHERE status = 'completed'), 0)::int AS entities
     FROM jobs
     WHERE team_id = $1 AND created_at >= date_trunc('month', NOW())`,
    [teamId]
  );
  return rows[0];
}

/**
 * Checks a job request against the per-job limits before it is queued. The monthly load limit is
 * applied by insertLimitedJob (services/job-enqueue.js), under a lock on the team row.
 */
export async function enforceJobCreationLimits(teamId, estimatedEntities) {
  const deployment = getDeployment();
  const limits = getLimits();

  if (!isUnlimited(limits.entitiesPerJob) && estimatedEntities > limits.entitiesPerJob) {
    throw limitExceededError("entitiesPerJob", limits.entitiesPerJob);
  }

  return { deployment, limits };
}

/** This load's position among the team's loads created in the same month (1-based). */
async function getMonthlyLoadRank(teamId, jobId) {
  const result = await query(
    `WITH target_job AS (
       SELECT created_at
       FROM jobs
       WHERE team_id = $1 AND id = $2
       LIMIT 1
     )
     SELECT COUNT(*)::int AS job_rank
     FROM jobs j
     JOIN target_job t ON true
     WHERE j.team_id = $1
       AND j.type = 'load'
       AND date_trunc('month', j.created_at) = date_trunc('month', t.created_at)
       AND (
         j.created_at < t.created_at
         OR (j.created_at = t.created_at AND j.id <= $2)
       )`,
    [teamId, jobId]
  );

  return Number(result.rows[0]?.job_rank || 0);
}

/** Re-checks the limits when the worker picks a job up, so queued jobs cannot bypass them. */
export async function enforceWorkerExecutionLimits({ teamId, jobId, type, estimatedEntities = 0 }) {
  if (!teamId || !jobId) {
    throw new Error("Missing teamId/jobId for worker usage enforcement.");
  }

  const deployment = getDeployment();
  const limits = getLimits();
  const entities = Math.max(0, Number(estimatedEntities || 0));

  if (!isUnlimited(limits.entitiesPerJob) && entities > limits.entitiesPerJob) {
    throw limitExceededError("entitiesPerJob", limits.entitiesPerJob);
  }

  if (type === "load" && !isUnlimited(limits.loadsPerMonth)) {
    const loadRank = await getMonthlyLoadRank(teamId, jobId);
    if (loadRank === 0) {
      throw new Error("Unable to determine monthly load usage position for this job.");
    }
    if (loadRank > limits.loadsPerMonth) {
      throw limitExceededError("loadsPerMonth", limits.loadsPerMonth);
    }
  }

  return { deployment, limits };
}

import fs from "fs/promises";
import { Router } from "express";
import { randomSeed } from "@easytestdata/core";
import { createJobSchema, estimateJobSchema } from "@easytestdata/shared/schemas";
import { authenticate } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { query } from "../db/pool.js";
import { requireRow } from "../services/route-helpers.js";
import { insertLimitedJob } from "../services/job-enqueue.js";
import { notifyJobQueued } from "../workers/runner.js";
import { requestJobCancel } from "../services/job-cancel.js";
import { AppError, ErrorCode } from "../errors.js";
import {
  estimateEntityCount,
  estimatePlan,
  normalizeScenarioConfig
} from "../services/scenario-config.js";
import {
  enforceJobCreationLimits,
  getDeployment,
  getLimits,
  getMonthlyUsage
} from "../services/limits.js";
import { resolveArtifactPath, selectArtifact } from "../services/job-artifacts.js";

function parseJsonMaybe(value) {
  if (!value) return {};
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/**
 * Why a load cannot get another rollback: one is queued, running or still stopping after a
 * cancel, or one already completed (which also moved the load from failed_with_orphans to
 * failed). Null when none.
 */
async function existingRollbackMessage(runQuery, jobId, teamId) {
  const { rows } = await runQuery(
    `SELECT status FROM jobs
     WHERE parent_job_id = $1 AND team_id = $2 AND type = 'rollback'
       AND status IN ('pending', 'running', 'cancelling', 'completed')
     ORDER BY (status = 'completed') DESC
     LIMIT 1`,
    [jobId, teamId]
  );
  if (rows.length === 0) return null;
  if (rows[0].status === "completed") return "This load has already been rolled back.";
  if (rows[0].status === "cancelling") {
    return "A cancelled rollback of this load is still stopping. Try again once it has.";
  }
  return "A rollback of this load is already running.";
}

// A load whose rollback completed. The worker moves such a load to failed, but its records are
// gone, so the UI shows it as rolled back rather than as a plain failure.
const ROLLED_BACK = `EXISTS (
  SELECT 1 FROM jobs rollback
  WHERE rollback.parent_job_id = jobs.id AND rollback.team_id = jobs.team_id
    AND rollback.type = 'rollback' AND rollback.status = 'completed'
) AS rolled_back`;

export function jobRoutes() {
  const router = Router();
  router.use(authenticate);

  router.get("/", async (req, res, next) => {
    try {
      const result = await query(
        `SELECT id, team_id, connection_id, type, status,
                config, progress, entity_count, error, started_at, completed_at, created_at, created_by,
                CASE WHEN result IS NOT NULL THEN jsonb_build_object(
                  'metrics', result->'metrics',
                  'counts', result->'counts',
                  'artifact', result->'artifact',
                  'artifacts', result->'artifacts',
                  'deletedByEntity', result->'deletedByEntity',
                  'deletedTotal', result->'deletedTotal',
                  'masterData', result->'masterData',
                  -- Purges record failureCount; loads only keep their failures list.
                  'failureCount', COALESCE(
                    result->'failureCount',
                    CASE WHEN jsonb_typeof(result->'failures') = 'array'
                      THEN to_jsonb(jsonb_array_length(result->'failures')) END
                  ),
                  'totalDeleted', result->'totalDeleted',
                  'totalInactivated', result->'totalInactivated',
                  'note', result->'note'
                ) ELSE NULL END AS result_summary,
                ${ROLLED_BACK}
         FROM jobs WHERE team_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [req.user.teamId]
      );
      res.json(result.rows);
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/",
    validate(async (req, res) => {
      const data = createJobSchema.parse(req.body);

      // The top-level templateId and connectionId win over any copies inside config (a re-run
      // posts a finished job's snapshot, which carries both).
      const normalizedConfig = normalizeScenarioConfig(
        { ...data.config, templateId: data.templateId, connectionId: data.connectionId },
        data.templateId
      );
      // One seed per job, snapshotted with the config: the estimate below, the worker and an admin
      // retry of this job all build the same plan.
      normalizedConfig.seed ??= randomSeed();

      // Only QBO-backed jobs use the connection; generate/export build an
      // artifact offline and must still work after the sandbox is disconnected.
      const jobUsesConnection = data.type !== "generate" && data.type !== "export";
      // A load that first purges ALL sandbox data is as destructive as a purge-all.
      if (
        jobUsesConnection &&
        normalizedConfig.purgeMode === "all" &&
        !["owner", "admin"].includes(req.user.role)
      ) {
        return res.status(403).json({
          error: "Only a team owner or admin can erase all data in a sandbox."
        });
      }
      if (jobUsesConnection && !normalizedConfig.connectionId) {
        return res
          .status(400)
          .json({ error: "Connect a QuickBooks sandbox before starting this job." });
      }
      let estimatedEntities = 0;
      if (data.type !== "purge") {
        estimatedEntities = estimateEntityCount(normalizedConfig);
      }

      await enforceJobCreationLimits(req.user.teamId, estimatedEntities);

      const snapshot = { ...normalizedConfig, templateId: data.templateId };

      // A QBO job's connection is locked and checked (404 missing, 409 disconnected) atomically
      // with the insert, so a concurrent disconnect cannot slip in between.
      const job = await insertLimitedJob({
        teamId: req.user.teamId,
        // Offline job types (generate/export) never use the connection, and their posted
        // connectionId is never checked: storing it could name a row that does not exist
        // (the FK to qbo_connections would reject it) or tie a file job to a sandbox.
        connectionId: jobUsesConnection ? normalizedConfig.connectionId : null,
        type: data.type,
        config: snapshot,
        createdBy: req.user.id
      });

      // The runner picks up pending rows; wake it so the job starts now. Jobs run once: a
      // retried load would write to QBO again.
      notifyJobQueued();

      return res.status(201).json(job);
    })
  );

  // What a job for this config would create, before it is started. The load screen reads `limit`
  // to warn about a plan over the per-job record limit.
  router.post(
    "/estimate",
    validate(async (req, res) => {
      const { templateId, config } = estimateJobSchema.parse(req.body);
      const normalizedConfig = normalizeScenarioConfig({ ...config, templateId }, templateId);
      res.json({ ...estimatePlan(normalizedConfig), limit: getLimits().entitiesPerJob });
    })
  );

  router.get("/usage", async (req, res, next) => {
    try {
      res.json({
        deployment: getDeployment(),
        limits: getLimits(),
        usage: await getMonthlyUsage(req.user.teamId)
      });
    } catch (err) {
      next(err);
    }
  });

  router.get(
    "/:id",
    validate(async (req, res) => {
      const result = await query(
        `SELECT jobs.*, ${ROLLED_BACK} FROM jobs WHERE id = $1 AND team_id = $2`,
        [req.params.id, req.user.teamId]
      );
      res.json(requireRow(result, "Job"));
    })
  );

  router.get(
    "/:id/download",
    validate(async (req, res) => {
      const result = await query("SELECT id, result FROM jobs WHERE id = $1 AND team_id = $2", [
        req.params.id,
        req.user.teamId
      ]);
      const job = requireRow(result, "Job");
      const format = typeof req.query.format === "string" ? req.query.format : undefined;
      const artifact = selectArtifact(parseJsonMaybe(job.result), format);
      const filePath = await resolveArtifactPath(artifact);

      if (!filePath) {
        return res.status(404).json({
          error: format
            ? `No ${format.toUpperCase()} file available for this job`
            : "No artifact available for this job"
        });
      }

      return res.download(filePath, artifact.filename);
    })
  );

  router.get(
    "/:id/data",
    validate(async (req, res) => {
      const result = await query("SELECT id, result FROM jobs WHERE id = $1 AND team_id = $2", [
        req.params.id,
        req.user.teamId
      ]);
      const job = requireRow(result, "Job");
      const artifact = selectArtifact(parseJsonMaybe(job.result), "json");
      const filePath = await resolveArtifactPath(artifact);

      if (!filePath) {
        return res.status(404).json({ error: "No data available for this job" });
      }

      const content = await fs.readFile(filePath, "utf8");
      res.json(JSON.parse(content));
    })
  );

  router.post(
    "/:id/rollback",
    validate(async (req, res) => {
      const result = await query("SELECT * FROM jobs WHERE id = $1 AND team_id = $2", [
        req.params.id,
        req.user.teamId
      ]);
      const job = requireRow(result, "Job");
      if (job.status !== "failed_with_orphans") {
        // A completed rollback moves its load to failed: say so instead of "not eligible".
        const conflict = await existingRollbackMessage(query, job.id, req.user.teamId);
        if (conflict) throw new AppError(409, ErrorCode.CONFLICT, conflict);
        return res.status(400).json({
          error: "Only a load that stopped with records left in QuickBooks can be rolled back."
        });
      }

      const payload = parseJsonMaybe(job.result);
      if (!payload?.ledger) {
        return res.status(400).json({ error: "No rollback data available for this job" });
      }

      // Under the connection guard (a disconnected sandbox has no tokens: 409, and the load stays
      // rollback-eligible until it is reconnected on the same row), one rollback per failed load:
      // refuse while another rollback of it is queued/running or has already completed.
      const rollbackJob = await insertLimitedJob({
        teamId: req.user.teamId,
        connectionId: job.connection_id,
        type: "rollback",
        createdBy: req.user.id,
        parentJobId: job.id,
        check: async (client) => {
          const conflict = await existingRollbackMessage(
            (...args) => client.query(...args),
            job.id,
            req.user.teamId
          );
          if (conflict) throw new AppError(409, ErrorCode.CONFLICT, conflict);
        }
      });
      notifyJobQueued();

      return res.status(201).json(rollbackJob);
    })
  );

  router.post("/:id/cancel", async (req, res, next) => {
    try {
      const job = await requestJobCancel(req.params.id, { teamId: req.user.teamId });
      if (!job) {
        return res.status(404).json({ error: "Job not found or not cancellable" });
      }
      res.json(job);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

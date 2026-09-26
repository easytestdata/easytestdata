import { Router } from "express";
import { query } from "../../db/pool.js";
import { notifyJobQueued } from "../../workers/runner.js";
import { abortRunningJob, JobForceFailedError } from "../../workers/index.js";
import { requestJobCancel } from "../../services/job-cancel.js";
import { insertLimitedJob, refuseReplayOverOrphans } from "../../services/job-enqueue.js";

export function jobRoutes() {
  const router = Router();

  // GET / — Cross-team paginated job list
  router.get("/", async (req, res, next) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
      const offset = (page - 1) * limit;
      const status = req.query.status || "";
      const type = req.query.type || "";
      const teamId = req.query.teamId || "";
      const dateFrom = req.query.dateFrom || "";
      const dateTo = req.query.dateTo || "";
      const sort = req.query.sort || "created_at";

      const conditions = [];
      const params = [];
      let paramIdx = 1;

      if (status) {
        conditions.push(`j.status = $${paramIdx}`);
        params.push(status);
        paramIdx++;
      }
      if (type) {
        conditions.push(`j.type = $${paramIdx}`);
        params.push(type);
        paramIdx++;
      }
      if (teamId) {
        conditions.push(`j.team_id = $${paramIdx}`);
        params.push(teamId);
        paramIdx++;
      }
      if (dateFrom) {
        conditions.push(`j.created_at >= $${paramIdx}`);
        params.push(dateFrom);
        paramIdx++;
      }
      if (dateTo) {
        conditions.push(`j.created_at <= $${paramIdx}`);
        params.push(dateTo);
        paramIdx++;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const sortCol = ["created_at", "completed_at"].includes(sort) ? sort : "created_at";

      const countResult = await query(`SELECT COUNT(*)::int AS total FROM jobs j ${where}`, params);
      const total = countResult.rows[0].total;

      const result = await query(
        `SELECT j.id, j.type, j.status, j.entity_count, j.created_at, j.started_at, j.completed_at,
                j.error, j.team_id, t.name AS team_name
         FROM jobs j
         LEFT JOIN teams t ON t.id = j.team_id
         ${where}
         ORDER BY j.${sortCol} DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      );

      res.json({ jobs: result.rows, total, page, limit });
    } catch (err) {
      next(err);
    }
  });

  // GET /stats — Job aggregated stats
  router.get("/stats", async (req, res, next) => {
    try {
      const statusBreakdown = await query(
        `SELECT status, COUNT(*)::int AS count FROM jobs
         WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY status`
      );

      const avgDuration = await query(
        `SELECT type,
                AVG(EXTRACT(EPOCH FROM (completed_at - started_at)))::int AS avg_seconds
         FROM jobs
         WHERE completed_at IS NOT NULL AND started_at IS NOT NULL
           AND created_at > NOW() - INTERVAL '30 days'
         GROUP BY type`
      );

      const failureRate = await query(
        `SELECT date_trunc('day', created_at) AS date,
                COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
                COUNT(*)::int AS total
         FROM jobs
         WHERE created_at > NOW() - INTERVAL '30 days'
         GROUP BY 1 ORDER BY 1`
      );

      res.json({
        statusBreakdown: statusBreakdown.rows,
        avgDuration: avgDuration.rows,
        failureRate: failureRate.rows
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /:id — Job detail
  router.get("/:id", async (req, res, next) => {
    try {
      const result = await query(
        `SELECT j.*, t.name AS team_name FROM jobs j
         LEFT JOIN teams t ON t.id = j.team_id
         WHERE j.id = $1`,
        [req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: "Job not found" });
      res.json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  });

  // POST /:id/cancel — Cancel a running job
  router.post("/:id/cancel", async (req, res, next) => {
    try {
      const job = await requestJobCancel(req.params.id);
      if (!job) return res.status(404).json({ error: "Job not found or not cancellable" });
      res.json({ success: true, status: job.status });
    } catch (err) {
      next(err);
    }
  });

  // POST /:id/retry — Re-enqueue a failed job (under the connection guard: 404/409 for a missing
  // or disconnected sandbox; 409 for a load whose records are still in the sandbox, see
  // refuseReplayOverOrphans). The copy belongs to the original job's team and
  // creator (the admin acts on the team's behalf) and goes through the same limits as any job:
  // the team's monthly load limit for a load (403) and one active QBO job per team (409). A rollback keeps
  // its parent, whose ledger says what to delete.
  router.post("/:id/retry", async (req, res, next) => {
    try {
      const jobResult = await query(
        "SELECT * FROM jobs WHERE id = $1 AND status IN ('failed', 'failed_with_orphans')",
        [req.params.id]
      );
      if (jobResult.rows.length === 0)
        return res.status(404).json({ error: "Job not found or not retryable" });

      const job = jobResult.rows[0];
      const newJob = await insertLimitedJob({
        teamId: job.team_id,
        connectionId: job.connection_id,
        type: job.type,
        config: job.config ?? {},
        createdBy: job.created_by ?? null,
        parentJobId: job.parent_job_id ?? null,
        check: (client) => refuseReplayOverOrphans(client, job)
      });
      notifyJobQueued();

      res.json(newJob);
    } catch (err) {
      next(err);
    }
  });

  // POST /:id/force-fail — Force-fail a stuck running job (never a cancelling one, which the
  // worker is already stopping). A job whose work runs in this process is aborted rather than
  // rewritten (202): the worker fails it through its normal path, which keeps a load's rollback
  // ledger and holds the team's QBO slot and the connection lock until the work has stopped.
  // Only a stale row (no run here) is marked failed at once.
  router.post("/:id/force-fail", async (req, res, next) => {
    const notRunning = () =>
      res
        .status(404)
        .json({ error: "Job not found or not running (a cancelling job is still stopping)" });
    try {
      const found = await query("SELECT id FROM jobs WHERE id = $1 AND status = 'running'", [
        req.params.id
      ]);
      if (found.rows.length === 0) return notRunning();

      if (abortRunningJob(req.params.id, new JobForceFailedError())) {
        return res.status(202).json({
          success: true,
          status: "running",
          message:
            "Stopping the job. It is marked failed once its work stops (a load keeps its rollback data)."
        });
      }

      const result = await query(
        `UPDATE jobs SET status = 'failed', error = 'Force-failed by admin', completed_at = NOW()
         WHERE id = $1 AND status = 'running' RETURNING id`,
        [req.params.id]
      );
      if (result.rows.length === 0) return notRunning();
      res.json({ success: true, status: "failed", message: "Job force-failed." });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

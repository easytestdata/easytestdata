import { Router } from "express";
import { query } from "../../db/pool.js";

export function dashboardRoutes() {
  const router = Router();

  // GET / — Aggregated KPI data plus basic server health
  router.get("/", async (req, res, next) => {
    try {
      const result = await query(
        `SELECT
           (SELECT COUNT(*)::int FROM users) AS total_users,
           (SELECT COUNT(*)::int FROM users WHERE created_at > NOW() - INTERVAL '7 days') AS new_users_7d,
           (SELECT COUNT(*)::int FROM teams) AS total_teams,
           (SELECT COUNT(*)::int FROM jobs WHERE status = 'running') AS active_jobs,
           (SELECT COUNT(*)::int FROM jobs WHERE created_at > CURRENT_DATE) AS jobs_today,
           (SELECT COUNT(*)::int FROM jobs WHERE status = 'failed' AND created_at > NOW() - INTERVAL '24 hours') AS failed_jobs_24h,
           (SELECT COUNT(*)::int FROM jobs) AS total_jobs,
           (SELECT COALESCE(SUM(entity_count), 0)::bigint FROM jobs WHERE status = 'completed') AS total_entities,
           (SELECT COUNT(*)::int FROM qbo_connections WHERE disconnected_at IS NULL) AS active_connections`
      );
      const row = result.rows[0];
      const byStatus = await query(
        "SELECT status, COUNT(*)::int AS count FROM jobs GROUP BY status ORDER BY status"
      );
      const mem = process.memoryUsage();
      res.json({
        totalUsers: row.total_users,
        newUsers7d: row.new_users_7d,
        totalTeams: row.total_teams,
        activeJobs: row.active_jobs,
        jobsToday: row.jobs_today,
        failedJobs24h: row.failed_jobs_24h,
        totalJobs: row.total_jobs,
        totalEntities: Number(row.total_entities),
        activeConnections: row.active_connections,
        // The queries above succeeding is the database check.
        system: {
          database: "ok",
          uptimeSeconds: Math.floor(process.uptime()),
          nodeVersion: process.version,
          memoryMb: {
            rss: Math.round(mem.rss / 1024 / 1024),
            heapUsed: Math.round(mem.heapUsed / 1024 / 1024)
          },
          jobsByStatus: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.count]))
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /trends — Time-series metrics
  router.get("/trends", async (req, res, next) => {
    try {
      const metric = req.query.metric || "signups";
      const period = req.query.period || "daily";
      const days = Math.min(parseInt(req.query.days) || 30, 365);

      const trunc = period === "weekly" ? "week" : "day";

      let sql;
      let params;
      if (metric === "signups") {
        sql = `
          SELECT date_trunc($1, created_at) AS date, COUNT(*)::int AS count
          FROM users
          WHERE created_at > NOW() - make_interval(days => $2)
          GROUP BY 1 ORDER BY 1`;
        params = [trunc, days];
      } else if (metric === "jobs") {
        sql = `
          SELECT date_trunc($1, created_at) AS date, type, COUNT(*)::int AS count
          FROM jobs
          WHERE created_at > NOW() - make_interval(days => $2)
          GROUP BY 1, 2 ORDER BY 1`;
        params = [trunc, days];
      } else if (metric === "entities") {
        sql = `
          SELECT date_trunc($1, completed_at) AS date, COALESCE(SUM(entity_count), 0)::bigint AS count
          FROM jobs
          WHERE completed_at > NOW() - make_interval(days => $2) AND status = 'completed'
          GROUP BY 1 ORDER BY 1`;
        params = [trunc, days];
      } else {
        return res.status(400).json({ error: "Invalid metric. Use: signups, jobs, entities" });
      }

      const result = await query(sql, params);
      res.json(result.rows.map((r) => ({ ...r, count: Number(r.count) })));
    } catch (err) {
      next(err);
    }
  });

  // GET /conversion-funnel. "Connected" counts teams with a sandbox connected now (disconnected
  // rows are kept for history), like active_connections above.
  router.get("/conversion-funnel", async (req, res, next) => {
    try {
      const result = await query(
        `SELECT
           (SELECT COUNT(*)::int FROM users) AS signups,
           (SELECT COUNT(DISTINCT team_id)::int FROM qbo_connections
            WHERE disconnected_at IS NULL) AS connected,
           (SELECT COUNT(DISTINCT team_id)::int FROM jobs WHERE status = 'completed') AS first_job`
      );
      res.json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

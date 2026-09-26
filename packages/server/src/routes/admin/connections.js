import { Router } from "express";
import { query } from "../../db/pool.js";
import {
  disconnectConnection,
  DISCONNECT_BUSY_MESSAGE
} from "../../services/connection-disconnect.js";

export function connectionRoutes() {
  const router = Router();

  // GET / — All connections with health indicators
  router.get("/", async (req, res, next) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
      const offset = (page - 1) * limit;
      const stale = req.query.stale === "true";
      const sort = req.query.sort || "last_used_at";

      // Disconnected sandboxes keep their row for their jobs' history; only connected ones list.
      const conditions = ["c.disconnected_at IS NULL"];
      if (stale) {
        // Never used since (re)connecting: idle since the connection date, as days_idle below.
        conditions.push("COALESCE(c.last_used_at, c.connected_at) < NOW() - INTERVAL '60 days'");
      }
      const where = `WHERE ${conditions.join(" AND ")}`;
      const sortCol = ["last_used_at", "connected_at"].includes(sort) ? sort : "last_used_at";

      const countResult = await query(
        `SELECT COUNT(*)::int AS total FROM qbo_connections c ${where}`
      );

      const result = await query(
        `SELECT c.id, c.company_name, c.realm_id, c.connected_at, c.last_used_at,
                c.team_id, t.name AS team_name,
                EXTRACT(DAY FROM NOW() - COALESCE(c.last_used_at, c.connected_at))::int AS days_idle,
                (SELECT COUNT(*)::int FROM jobs j WHERE j.connection_id = c.id) AS job_count
         FROM qbo_connections c
         LEFT JOIN teams t ON t.id = c.team_id
         ${where}
         ORDER BY c.${sortCol} DESC NULLS LAST
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      res.json({ connections: result.rows, total: countResult.rows[0].total, page, limit });
    } catch (err) {
      next(err);
    }
  });

  // POST /:id/test — Test a connection
  router.post("/:id/test", async (req, res, next) => {
    try {
      // Just verify the connection record exists
      const result = await query(
        "SELECT id, company_name FROM qbo_connections WHERE id = $1 AND disconnected_at IS NULL",
        [req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: "Connection not found" });
      res.json({ ok: true, companyName: result.rows[0].company_name });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /:id — Force disconnect, with the team disconnect's rules: keeps the row (history),
  // refused (409) while a job or the lock uses the sandbox (cancel the job first).
  router.delete("/:id", async (req, res, next) => {
    try {
      const outcome = await disconnectConnection(req.params.id);
      if (outcome === "busy") return res.status(409).json({ error: DISCONNECT_BUSY_MESSAGE });
      if (outcome === "absent") return res.status(404).json({ error: "Connection not found" });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

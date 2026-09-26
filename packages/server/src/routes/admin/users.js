import { Router } from "express";
import { query } from "../../db/pool.js";
import { revokeUserCredentials } from "../../auth/session.js";
import { toCsv } from "../../services/csv.js";
import { requireAdmin } from "./middleware.js";

export function userRoutes() {
  const router = Router();

  // GET / — Paginated user list
  router.get("/", async (req, res, next) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
      const offset = (page - 1) * limit;
      const search = req.query.search || "";
      const provider = req.query.provider || "";
      const suspended = req.query.suspended;
      const sort = req.query.sort || "created_at";

      const conditions = [];
      const params = [];
      let paramIdx = 1;

      if (search) {
        conditions.push(`(u.email ILIKE $${paramIdx} OR u.display_name ILIKE $${paramIdx})`);
        params.push(`%${search}%`);
        paramIdx++;
      }
      if (provider) {
        conditions.push(`u.oauth_provider = $${paramIdx}`);
        params.push(provider);
        paramIdx++;
      }
      if (suspended === "true") conditions.push("u.suspended_at IS NOT NULL");
      if (suspended === "false") conditions.push("u.suspended_at IS NULL");

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const sortCol = ["created_at", "email"].includes(sort) ? sort : "created_at";

      const countResult = await query(
        `SELECT COUNT(*)::int AS total FROM users u ${where}`,
        params
      );
      const total = countResult.rows[0].total;

      const result = await query(
        `SELECT u.id, u.email, u.display_name, u.oauth_provider, u.avatar_url,
                u.is_admin, u.suspended_at, u.suspended_reason,
                u.created_at,
                COALESCE(tm_agg.cnt, 0) AS team_count,
                COALESCE(j_agg.cnt, 0) AS job_count
         FROM users u
         LEFT JOIN (SELECT user_id, COUNT(*)::int AS cnt FROM team_members GROUP BY user_id) tm_agg ON tm_agg.user_id = u.id
         LEFT JOIN (
           SELECT tm2.user_id, COUNT(*)::int AS cnt
           FROM jobs j JOIN team_members tm2 ON tm2.team_id = j.team_id
           GROUP BY tm2.user_id
         ) j_agg ON j_agg.user_id = u.id
         ${where}
         ORDER BY u.${sortCol} DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      );

      res.json({ users: result.rows, total, page, limit });
    } catch (err) {
      next(err);
    }
  });

  // GET /export — Export users as CSV (bulk PII: admins only, gated here as well as by the admin
  // router so a router reshuffle cannot expose it)
  router.get("/export", requireAdmin, async (req, res, next) => {
    try {
      const result = await query(
        `SELECT u.id, u.email, u.display_name, u.oauth_provider, u.is_admin, u.suspended_at,
                u.created_at
         FROM users u ORDER BY u.created_at DESC`
      );
      const header = [
        "id",
        "email",
        "display_name",
        "oauth_provider",
        "is_admin",
        "suspended",
        "created_at"
      ];
      const rows = result.rows.map((r) => [
        r.id,
        r.email,
        r.display_name || "",
        r.oauth_provider || "",
        r.is_admin,
        !!r.suspended_at,
        r.created_at
      ]);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=users.csv");
      res.send(toCsv(header, rows));
    } catch (err) {
      next(err);
    }
  });

  // GET /:id — User detail
  router.get("/:id", async (req, res, next) => {
    try {
      const userResult = await query("SELECT * FROM users WHERE id = $1", [req.params.id]);
      if (userResult.rows.length === 0) return res.status(404).json({ error: "User not found" });

      const user = userResult.rows[0];

      const teams = await query(
        `SELECT t.id, t.name, tm.role FROM team_members tm
         JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = $1`,
        [req.params.id]
      );

      const recentJobs = await query(
        `SELECT j.id, j.type, j.status, j.entity_count, j.created_at
         FROM jobs j JOIN team_members tm ON tm.team_id = j.team_id
         WHERE tm.user_id = $1 ORDER BY j.created_at DESC LIMIT 20`,
        [req.params.id]
      );

      res.json({
        user,
        teams: teams.rows,
        recentJobs: recentJobs.rows
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /:id/suspend
  router.post("/:id/suspend", async (req, res, next) => {
    try {
      const { reason } = req.body || {};
      const result = await query(
        `UPDATE users SET suspended_at = NOW(), suspended_reason = $1, suspended_by = $2
         WHERE id = $3 AND suspended_at IS NULL RETURNING id`,
        [reason || null, req.user.id, req.params.id]
      );
      if (result.rows.length === 0)
        return res.status(404).json({ error: "User not found or already suspended" });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /:id/unsuspend
  router.post("/:id/unsuspend", async (req, res, next) => {
    try {
      const result = await query(
        `UPDATE users SET suspended_at = NULL, suspended_reason = NULL, suspended_by = NULL
         WHERE id = $1 AND suspended_at IS NOT NULL RETURNING id`,
        [req.params.id]
      );
      if (result.rows.length === 0)
        return res.status(404).json({ error: "User not found or not suspended" });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /:id/revoke-sessions — sign the user out everywhere (refresh tokens, and live access
  // tokens via the session version)
  router.post("/:id/revoke-sessions", async (req, res, next) => {
    try {
      const target = await query("SELECT id FROM users WHERE id = $1", [req.params.id]);
      if (target.rows.length === 0) return res.status(404).json({ error: "User not found" });
      await revokeUserCredentials(req.params.id);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

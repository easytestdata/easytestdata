import { config } from "../config.js";
import { query } from "../db/pool.js";
import { logger } from "../logger.js";
import { sessionVersionMatches, verifyAccessToken } from "../auth/tokens.js";
import { getLocalIdentity } from "../local/identity.js";

/**
 * Loads the user's status and every team membership ({ teamId: role }) in one query. It runs on
 * every request, so suspension, sign-out everywhere and membership changes apply immediately.
 */
async function ensureActiveUser(userId) {
  const result = await query(
    `SELECT u.id, u.suspended_at, u.is_admin, u.session_version,
            COALESCE(
              (SELECT json_object_agg(tm.team_id, tm.role)
               FROM team_members tm WHERE tm.user_id = u.id),
              '{}'::json
            ) AS memberships
     FROM users u
     WHERE u.id = $1
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] ?? null;
}

export async function authenticate(req, res, next) {
  // Local mode: no sign-in. Every request is the one local user, owner of the one local team;
  // local/guards.js keeps other sites from sending these requests.
  if (config.deployment === "local") {
    req.user = { ...getLocalIdentity(), role: "owner", isAdmin: false };
    return next();
  }

  let authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "Authorization header required" });
  }

  // JWT auth
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      if (err.name === "TokenExpiredError" || err.name === "JsonWebTokenError") {
        return res.status(401).json({ error: "Invalid or expired token" });
      }
      logger.error({ err }, "JWT verification error");
      return res.status(500).json({ error: "Authentication failed" });
    }

    try {
      const user = await ensureActiveUser(payload.sub);
      if (!user) return res.status(401).json({ error: "Invalid or expired token" });
      if (user.suspended_at) return res.status(403).json({ error: "Account is suspended" });
      if (!sessionVersionMatches(payload, user)) {
        return res.status(401).json({ error: "Invalid or expired token", code: "SESSION_REVOKED" });
      }
      // The token's teamId is only a claim: the membership (and the role) come from the DB, so
      // a removed member loses access immediately. 401 makes the client refresh, which issues a
      // token for a team the user still belongs to.
      const role = user.memberships?.[payload.teamId];
      if (!payload.teamId || !role) {
        return res
          .status(401)
          .json({ error: "Team membership is no longer valid", code: "TEAM_MEMBERSHIP_REVOKED" });
      }
      req.user = {
        id: payload.sub,
        email: payload.email,
        teamId: payload.teamId,
        role,
        // The session generation this request was authenticated in; anything that mints a new
        // session from this request must issue it for this generation (see issueSession).
        sessionVersion: payload.sv,
        isAdmin: user.is_admin === true
      };
      return next();
    } catch (err) {
      logger.error({ err }, "Authentication lookup error");
      return res.status(503).json({ error: "Authentication service unavailable" });
    }
  }

  return res.status(401).json({ error: "Invalid authorization format" });
}

/** Requires the caller's role in their current team (from the DB, see authenticate). */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ error: `This action requires the ${roles.join(" or ")} role in this team.` });
    }
    next();
  };
}

/** Owners and admins manage a team's connections, invites and destructive purges. */
export const requireTeamManager = requireRole("owner", "admin");

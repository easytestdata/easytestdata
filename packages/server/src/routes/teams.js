import { Router } from "express";
import crypto from "crypto";
import { acceptInviteSchema, inviteSchema } from "@easytestdata/shared/schemas";
import { config } from "../config.js";
import { authenticate } from "../middleware/auth.js";
import { buildAuthResponse, issueSession, setActiveTeam } from "../auth/session.js";
import { validate } from "../middleware/validate.js";
import { query, rollback, transaction } from "../db/pool.js";
import { getLimits, limitExceededError } from "../services/limits.js";
import { generateHashedToken, normalizeEmail } from "../services/route-helpers.js";

async function getMembership(teamId, userId) {
  const result = await query(
    "SELECT * FROM team_members WHERE team_id = $1 AND user_id = $2 LIMIT 1",
    [teamId, userId]
  );
  return result.rows[0] || null;
}

function getTeamInviteLockKeys(teamId) {
  const digest = crypto.createHash("sha256").update(`team-invite:${teamId}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

async function lockTeamInvites(client, teamId) {
  const [lockKeyOne, lockKeyTwo] = getTeamInviteLockKeys(teamId);
  await client.query("SELECT pg_advisory_xact_lock($1, $2)", [lockKeyOne, lockKeyTwo]);
}

async function getTeamSeatUsage(client, teamId, excludeInviteId = null) {
  const result = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM team_members WHERE team_id = $1) AS member_count,
       (
         SELECT COUNT(*)::int
         FROM team_invites
         WHERE team_id = $1
           AND accepted_at IS NULL
           AND expires_at > NOW()
           AND ($2::uuid IS NULL OR id <> $2::uuid)
           AND NOT EXISTS (
             SELECT 1
             FROM team_members tm
             JOIN users u ON u.id = tm.user_id
             WHERE tm.team_id = team_invites.team_id
               AND LOWER(u.email) = LOWER(team_invites.email)
           )
       ) AS pending_invite_count`,
    [teamId, excludeInviteId]
  );
  const row = result.rows[0] || {};
  return {
    memberCount: Number(row.member_count || 0),
    pendingInviteCount: Number(row.pending_invite_count || 0)
  };
}

function inviteUrlFor(token) {
  return `${config.appUrl}/invite?token=${encodeURIComponent(token)}`;
}

function seatsAtOrOverLimit({ memberCount, pendingInviteCount }, limit) {
  return limit !== -1 && memberCount + pendingInviteCount >= limit;
}

export function teamRoutes() {
  const router = Router();
  router.use(authenticate);

  router.get("/", async (req, res, next) => {
    try {
      const result = await query(
        `SELECT t.*, tm.role FROM teams t
         JOIN team_members tm ON tm.team_id = t.id
         WHERE tm.user_id = $1`,
        [req.user.id]
      );
      res.json(result.rows);
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/members", async (req, res, next) => {
    try {
      const membership = await getMembership(req.params.id, req.user.id);
      if (!membership) return res.status(403).json({ error: "Not a team member" });

      const result = await query(
        `SELECT tm.*, u.email, u.display_name, u.avatar_url
         FROM team_members tm
         JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = $1`,
        [req.params.id]
      );
      res.json(result.rows);
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/invites", async (req, res, next) => {
    try {
      const membership = await getMembership(req.params.id, req.user.id);
      if (!membership) return res.status(403).json({ error: "Not a team member" });

      const invites = await query(
        `SELECT id, email, role, expires_at, created_at
         FROM team_invites
         WHERE team_id = $1 AND accepted_at IS NULL AND expires_at > NOW()
         ORDER BY created_at DESC`,
        [req.params.id]
      );
      res.json(invites.rows);
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/:id/invites",
    validate(async (req, res) => {
      const membership = await getMembership(req.params.id, req.user.id);
      if (!membership || !["owner", "admin"].includes(membership.role)) {
        return res.status(403).json({ error: "Only owners/admins can invite members" });
      }

      const data = inviteSchema.parse(req.body);
      const email = normalizeEmail(data.email);
      const outcome = await transaction(async (client) => {
        await lockTeamInvites(client, req.params.id);

        const existingInvite = await client.query(
          `SELECT id, email, role, expires_at, created_at
           FROM team_invites
           WHERE team_id = $1 AND email = $2 AND accepted_at IS NULL AND expires_at > NOW()
           ORDER BY created_at DESC
           LIMIT 1`,
          [req.params.id, email]
        );
        if (existingInvite.rows.length > 0) {
          // The inviter delivers the link, but only its hash is stored, so issue a fresh token
          // (invalidating the old link) and return it. The re-issued link is a new invite in all
          // but its row: the role just chosen and a full expiry from now, never the old ones.
          const { raw: token, hash: tokenHash } = generateHashedToken(24);
          const expiresAt = new Date(Date.now() + config.tokens.teamInviteTtlMs);
          const reissued = await client.query(
            `UPDATE team_invites SET token = $1, role = $2, expires_at = $3
             WHERE id = $4
             RETURNING id, email, role, expires_at, created_at`,
            [tokenHash, data.role, expiresAt, existingInvite.rows[0].id]
          );
          return {
            status: 200,
            body: {
              ...reissued.rows[0],
              alreadyPending: true,
              inviteUrl: inviteUrlFor(token)
            }
          };
        }

        const limits = getLimits();
        const seatUsage = await getTeamSeatUsage(client, req.params.id);
        if (seatsAtOrOverLimit(seatUsage, limits.teamMembers)) {
          throw limitExceededError("teamMembers", limits.teamMembers);
        }

        const { raw: token, hash: tokenHash } = generateHashedToken(24);
        const expiresAt = new Date(Date.now() + config.tokens.teamInviteTtlMs);
        const inserted = await client.query(
          `INSERT INTO team_invites (team_id, email, role, token, invited_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, email, role, expires_at, created_at`,
          [req.params.id, email, data.role, tokenHash, req.user.id, expiresAt]
        );
        // Nothing sends email: the inviter shares the link themselves.
        return { status: 201, body: { ...inserted.rows[0], inviteUrl: inviteUrlFor(token) } };
      });

      res.status(outcome.status).json(outcome.body);
    })
  );

  // Revoke a pending invite (owner/admin of that team).
  router.delete("/:id/invites/:inviteId", async (req, res, next) => {
    try {
      const membership = await getMembership(req.params.id, req.user.id);
      if (!membership || !["owner", "admin"].includes(membership.role)) {
        return res.status(403).json({ error: "Only owners/admins can revoke invites" });
      }
      const result = await query(
        "DELETE FROM team_invites WHERE id = $1 AND team_id = $2 AND accepted_at IS NULL RETURNING id",
        [req.params.inviteId, req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: "Invite not found" });
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  });

  // Remove a member (owner/admin), or leave the team (any non-owner member removing themself).
  // The owner cannot be removed; admins cannot remove other admins.
  router.delete("/:id/members/:userId", async (req, res, next) => {
    try {
      const actor = await getMembership(req.params.id, req.user.id);
      if (!actor) return res.status(403).json({ error: "Not a team member" });
      const target = await getMembership(req.params.id, req.params.userId);
      if (!target) return res.status(404).json({ error: "Member not found" });

      const leaving = req.params.userId === req.user.id;
      if (target.role === "owner") {
        return res.status(400).json({ error: "The team owner cannot be removed" });
      }
      if (!leaving) {
        const allowed =
          actor.role === "owner" || (actor.role === "admin" && target.role === "member");
        if (!allowed) {
          return res.status(403).json({ error: "You cannot remove this member" });
        }
      }

      await query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2", [
        req.params.id,
        req.params.userId
      ]);
      await query("UPDATE users SET active_team_id = NULL WHERE id = $1 AND active_team_id = $2", [
        req.params.userId,
        req.params.id
      ]);
      // `authenticate` reads memberships from the database: the next request with a token for
      // this team gets 401 and the client refreshes into a team they still belong to.
      res.json({ removed: true });
    } catch (err) {
      next(err);
    }
  });

  // The token is in the body, not the path: request URLs are logged (pino-http, the error
  // handler), bodies are not (and the error handler's Sentry copy redacts `token`).
  router.post("/invites/accept", async (req, res, next) => {
    const parsed = acceptInviteSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    try {
      const tokenHash = crypto.createHash("sha256").update(parsed.data.token).digest("hex");
      const outcome = await transaction(async (client) => {
        // Take the team's invite lock before the invite row, the order re-inviting uses (lock,
        // then rotate the row's token); the opposite order can deadlock with it.
        const inviteTeam = await client.query("SELECT team_id FROM team_invites WHERE token = $1", [
          tokenHash
        ]);
        if (inviteTeam.rows.length > 0) await lockTeamInvites(client, inviteTeam.rows[0].team_id);

        const inviteResult = await client.query(
          `SELECT * FROM team_invites
           WHERE token = $1 AND accepted_at IS NULL AND expires_at > NOW()
           LIMIT 1
           FOR UPDATE`,
          [tokenHash]
        );
        if (inviteResult.rows.length === 0) {
          return rollback({ status: 404, body: { error: "Invite not found or expired" } });
        }

        const invite = inviteResult.rows[0];
        const userResult = await client.query("SELECT email FROM users WHERE id = $1", [
          req.user.id
        ]);
        const userEmail = String(userResult.rows[0]?.email || "").toLowerCase();
        if (userEmail !== String(invite.email || "").toLowerCase()) {
          return rollback({
            status: 403,
            body: { error: "Invite email does not match signed-in account" }
          });
        }

        const membership = await client.query(
          "SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 LIMIT 1",
          [invite.team_id, req.user.id]
        );
        if (membership.rows.length === 0) {
          const limits = getLimits();
          const seatUsage = await getTeamSeatUsage(client, invite.team_id, invite.id);
          if (seatsAtOrOverLimit(seatUsage, limits.teamMembers)) {
            throw limitExceededError("teamMembers", limits.teamMembers);
          }

          await client.query(
            `INSERT INTO team_members (team_id, user_id, role)
             VALUES ($1, $2, $3)
             ON CONFLICT (team_id, user_id) DO NOTHING`,
            [invite.team_id, req.user.id, invite.role || "member"]
          );
        }

        await client.query("UPDATE team_invites SET accepted_at = NOW() WHERE id = $1", [
          invite.id
        ]);
        // Switch the invitee into the team they just joined.
        await setActiveTeam(req.user.id, invite.team_id, client);
        const roleResult = await client.query(
          "SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2",
          [invite.team_id, req.user.id]
        );
        const userRow = await client.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
        const role = roleResult.rows[0]?.role || invite.role || "member";
        // Issue for the generation this request authenticated in (see switch-team).
        const tokens = await issueSession(
          { ...userRow.rows[0], session_version: req.user.sessionVersion },
          { teamId: invite.team_id, role },
          client
        );
        return {
          status: 200,
          body: {
            accepted: true,
            teamId: invite.team_id,
            role,
            ...buildAuthResponse(
              userRow.rows[0],
              invite.team_id,
              tokens.accessToken,
              tokens.refreshToken
            )
          }
        };
      });
      res.status(outcome.status).json(outcome.body);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

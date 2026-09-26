import crypto from "crypto";
import { config } from "../config.js";
import { query, transaction } from "../db/pool.js";
import { AppError, ErrorCode } from "../errors.js";
import { signAccessToken } from "./tokens.js";

/** The user's current session generation (users.session_version); tokens carry it as `sv`. */
export function sessionVersionOf(user) {
  return Number(user?.session_version ?? 0);
}

/**
 * Thrown when a session cannot be issued because the user's credentials were revoked between
 * the request being authenticated and the refresh token being stored. Maps to 401.
 */
export class SessionRevokedError extends AppError {
  constructor() {
    super(401, ErrorCode.SESSION_REVOKED, "Invalid or expired token");
    this.name = "SessionRevokedError";
  }
}

/**
 * Issues an access/refresh token pair. `user` must be the users row (or carry its
 * `session_version`) so the access token's `sv` matches what `authenticate` checks.
 */
export function generateTokens(user, teamId, role) {
  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    teamId,
    role,
    sv: sessionVersionOf(user)
  });
  const refreshToken = crypto.randomBytes(48).toString("hex");
  return { accessToken, refreshToken };
}

export function hashRefreshToken(refreshToken) {
  return crypto.createHash("sha256").update(refreshToken).digest("hex");
}

/**
 * Runs `fn(client)` inside `db` when a transaction client was supplied, otherwise inside a
 * transaction of its own. Session issuance and revocation lock the users row (FOR NO KEY UPDATE:
 * it conflicts with itself and with the session_version UPDATE, not with the KEY SHARE a
 * foreign-key check takes), which only serializes them against each other while that lock is
 * held to the commit.
 */
function withTransaction(db, fn) {
  return db ? fn(db) : transaction(fn);
}

/**
 * Locks the users row for the rest of the transaction and returns its session generation
 * (null when the user no longer exists). Every session issuance and every revocation takes this
 * lock first, so one of two concurrent ones waits for the other to commit and then sees its
 * generation: a refresh token can never be stored for a generation that a revocation in flight
 * is about to retire.
 */
export async function lockSessionVersion(userId, client) {
  const locked = await client.query(
    "SELECT session_version FROM users WHERE id = $1 FOR NO KEY UPDATE",
    [userId]
  );
  const row = locked.rows?.[0];
  return row ? Number(row.session_version) : null;
}

/**
 * Stores a refresh token for the session generation it was minted in. The row records that
 * generation (refresh_tokens.session_version) so /refresh can refuse a token that
 * outlived a revocation, and the insert is conditional on users.session_version still being
 * `sessionVersion`: nothing is stored and false is returned when the generation has moved on.
 */
export async function storeRefreshToken(userId, refreshToken, sessionVersion, db = { query }) {
  const expiresAt = new Date(Date.now() + config.tokens.refreshTokenTtlMs);
  const stored = await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, session_version)
     SELECT id, $2, $3, $4 FROM users WHERE id = $1 AND session_version = $4`,
    [userId, hashRefreshToken(refreshToken), expiresAt, Number(sessionVersion)]
  );
  return Number(stored?.rowCount ?? 0) > 0;
}

export function buildAuthResponse(user, teamId, accessToken, refreshToken) {
  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name || user.displayName,
      avatarUrl: user.avatar_url || user.avatarUrl || null
    },
    teamId,
    accessToken,
    refreshToken
  };
}

export async function ensureTeamForUser(userId, displayName, db = { query }) {
  const existingMembership = await db.query(
    `SELECT tm.team_id, tm.role
     FROM team_members tm
     WHERE tm.user_id = $1
     ORDER BY CASE tm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, tm.created_at ASC
     LIMIT 1`,
    [userId]
  );

  if (existingMembership.rows.length > 0) {
    return {
      teamId: existingMembership.rows[0].team_id,
      role: existingMembership.rows[0].role
    };
  }

  const team = await db.query("INSERT INTO teams (name) VALUES ($1) RETURNING id", [
    `${displayName}'s Team`
  ]);
  const teamId = team.rows[0].id;

  await db.query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')", [
    teamId,
    userId
  ]);

  return { teamId, role: "owner" };
}

export async function setActiveTeam(userId, teamId, db = { query }) {
  await db.query("UPDATE users SET active_team_id = $2 WHERE id = $1", [userId, teamId]);
}

/**
 * The team a new session is issued for: the user's active team while they are still a member of
 * it, otherwise their own team (ensureTeamForUser), which then becomes the active team.
 */
export async function resolveSessionTeam(userId, displayName, db = { query }) {
  const active = await db.query(
    `SELECT tm.team_id, tm.role
     FROM users u
     JOIN team_members tm ON tm.user_id = u.id AND tm.team_id = u.active_team_id
     WHERE u.id = $1`,
    [userId]
  );
  if (active.rows.length > 0) {
    return { teamId: active.rows[0].team_id, role: active.rows[0].role };
  }
  const membership = await ensureTeamForUser(userId, displayName, db);
  await setActiveTeam(userId, membership.teamId, db);
  return membership;
}

/**
 * Issues and stores a new access/refresh token pair for `user` in `membership.teamId`, in the
 * session generation `user.session_version`. For a request that was authenticated with an
 * access token, pass that token's generation (req.user.sessionVersion) so a revocation that
 * completed after `authenticate` ran cannot be turned into a fresh 30-day session. The users
 * row is locked (lockSessionVersion) before the generation is compared and the token stored,
 * inside `db`'s transaction or one of its own, so an issuance and a revocation never interleave.
 * Throws SessionRevokedError (401) when the generation has moved on.
 */
export async function issueSession(user, membership, db = null) {
  const expected = sessionVersionOf(user);
  const tokens = generateTokens(user, membership.teamId, membership.role);
  await withTransaction(db, async (client) => {
    const current = await lockSessionVersion(user.id, client);
    if (current !== expected) throw new SessionRevokedError();
    const stored = await storeRefreshToken(user.id, tokens.refreshToken, expected, client);
    if (!stored) throw new SessionRevokedError();
  });
  return tokens;
}

/**
 * Signs the user out everywhere: bumps users.session_version so access tokens issued before now
 * (which carry the old `sv`) are rejected by `authenticate` immediately instead of staying valid
 * for their 15-minute lifetime, and deletes every refresh token. The users row is locked first
 * (lockSessionVersion), so a session being issued concurrently either stores its token before
 * the delete or sees the new generation and refuses.
 *
 * With `ifSessionVersion`, nothing is revoked unless the user is still in that generation
 * (SessionRevokedError, 401): a signed-in flow passes the generation its request authenticated
 * in, so a revocation that landed meanwhile is not silently overridden.
 *
 * Returns `{ sessionVersion }`. `authenticate` reads the user from the database on every
 * request, so the bump takes effect as soon as it is committed.
 */
export async function revokeUserCredentials(userId, db = null, options = {}) {
  const { ifSessionVersion } = options;
  const sessionVersion = await withTransaction(db, async (client) => {
    const current = await lockSessionVersion(userId, client);
    if (ifSessionVersion !== undefined && current !== Number(ifSessionVersion)) {
      throw new SessionRevokedError();
    }
    const bumped = await client.query(
      "UPDATE users SET session_version = session_version + 1 WHERE id = $1 RETURNING session_version",
      [userId]
    );
    await client.query("DELETE FROM refresh_tokens WHERE user_id = $1", [userId]);
    return bumped.rows?.[0]?.session_version ?? null;
  });
  return { sessionVersion };
}

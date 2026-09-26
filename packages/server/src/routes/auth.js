import { Router } from "express";
import crypto from "crypto";
import passport from "passport";
import {
  refreshSchema,
  oauthExchangeSchema,
  oauthCallbackSchema,
  switchTeamSchema
} from "@easytestdata/shared/schemas";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { query, rollback, transaction } from "../db/pool.js";
import { authenticate } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { setupPassportStrategies } from "../auth/passport-setup.js";
import { beginOAuthState, consumeOAuthState } from "../auth/oauth-state.js";
import { STATE_TYPES } from "../auth/tokens.js";
import { oauthCodes } from "../state/memory.js";
import {
  buildAuthResponse,
  hashRefreshToken,
  issueSession,
  lockSessionVersion,
  resolveSessionTeam,
  revokeUserCredentials,
  sessionVersionOf,
  setActiveTeam
} from "../auth/session.js";
import { applyAdminBootstrap } from "../services/admin-bootstrap.js";
import { normalizeEmail } from "../services/route-helpers.js";

const OAUTH_CODE_TTL = config.tokens.oauthCodeTtlSec;
// A rotated refresh token presented again within this window is treated as a benign race
// (two tabs refreshing at once) and just rejected; later reuse revokes every session.
const REFRESH_REUSE_GRACE_SEC = 30;
const LOGIN_STATE_COOKIE = "eztd_oauth_login";
const LOGIN_STATE_COOKIE_PATH = "/api/v1/auth";

/** A sign-in the server refuses on purpose; `code` becomes `/login?error=<code>`. */
class OAuthLoginError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Finds or creates the user for an OAuth login.
 *
 * - A returning login is matched by (provider, provider id) only.
 * - Otherwise the provider must assert that the email is verified (Google email_verified, GitHub
 *   primary+verified, Intuit emailVerified); a login without that is refused. Every stored email
 *   was verified this way, so a verified login with the same email is the same person: it is
 *   attached to the existing account (which moves the account's OAuth link to this provider).
 * - Otherwise a new account is created for the verified email.
 */
export async function upsertOAuthUser(profile) {
  const email = profile.email ? normalizeEmail(profile.email) : null;

  const byProvider = await query(
    "SELECT * FROM users WHERE oauth_provider = $1 AND oauth_provider_id = $2 LIMIT 1",
    [profile.provider, profile.providerId]
  );

  if (byProvider.rows.length > 0) {
    const user = byProvider.rows[0];
    await query(
      "UPDATE users SET display_name = $1, avatar_url = $2, updated_at = NOW() WHERE id = $3",
      [profile.displayName, profile.avatarUrl, user.id]
    );
    return user;
  }

  if (!email) {
    throw new OAuthLoginError(
      "oauth_no_email",
      `${profile.provider} did not provide an email address. Please use a different sign-in method.`
    );
  }

  if (profile.linkByEmail !== true) {
    throw new OAuthLoginError(
      "oauth_email_unverified",
      `${profile.provider} has not verified the email address on this account.`
    );
  }

  const byEmail = await query("SELECT * FROM users WHERE email = $1 LIMIT 1", [email]);
  const existing = byEmail.rows[0] || null;

  if (existing) {
    const updated = await query(
      `UPDATE users
       SET oauth_provider = $1, oauth_provider_id = $2, display_name = $3, avatar_url = $4,
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [profile.provider, profile.providerId, profile.displayName, profile.avatarUrl, existing.id]
    );
    return updated.rows[0] || existing;
  }

  const created = await query(
    `INSERT INTO users (email, display_name, avatar_url, oauth_provider, oauth_provider_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [email, profile.displayName, profile.avatarUrl, profile.provider, profile.providerId]
  );
  return created.rows[0];
}

/**
 * An OAuth code may only be exchanged for the account exactly as it was when the provider
 * authenticated it: same session generation and same OAuth link. A sign-out everywhere changes
 * the generation, and a verified login through another provider moves the link.
 */
function oauthCodeStillValid(tokenData, user) {
  return (
    Number.isInteger(tokenData?.sessionVersion) &&
    tokenData.sessionVersion === sessionVersionOf(user) &&
    (tokenData.provider ?? null) === (user.oauth_provider ?? null) &&
    (tokenData.providerId ?? null) === (user.oauth_provider_id ?? null)
  );
}

async function issueOAuthCode(payload) {
  const code = crypto.randomBytes(32).toString("hex");
  oauthCodes.set(code, payload, OAUTH_CODE_TTL * 1000);
  return code;
}

function isProviderConfigured(provider) {
  if (provider === "google") {
    return Boolean(config.oauth.google.clientId && config.oauth.google.clientSecret);
  }
  if (provider === "github") {
    return Boolean(config.oauth.github.clientId && config.oauth.github.clientSecret);
  }
  if (provider === "intuit") {
    return Boolean(config.oauth.intuit.clientId && config.oauth.intuit.clientSecret);
  }
  return false;
}

function handleOAuthProvider(provider) {
  return async (req, res, next) => {
    if (!isProviderConfigured(provider)) {
      return res.redirect(`/login?error=${provider}_oauth_not_configured`);
    }

    let state;
    try {
      state = await beginOAuthState({
        res,
        type: STATE_TYPES.login,
        cookieName: LOGIN_STATE_COOKIE,
        cookiePath: LOGIN_STATE_COOKIE_PATH,
        payload: { provider }
      });
    } catch (err) {
      logger.error({ err, provider }, "Failed to start OAuth login");
      return res.redirect("/login?error=oauth_unavailable");
    }

    const options = {
      session: false,
      state
    };

    if (provider === "google") {
      options.scope = ["profile", "email"];
    } else if (provider === "intuit") {
      options.scope = ["openid", "profile", "email"];
    }

    return passport.authenticate(provider, options)(req, res, next);
  };
}

function handleOAuthCallback(provider) {
  return async (req, res, next) => {
    let stateData;
    // Cancelled or declined at the provider (e.g. error=access_denied): use up the state and its
    // cookie, then say so instead of asking the provider to finish a sign-in that never happened.
    if (req.query.error) {
      try {
        await consumeOAuthState({
          req,
          res,
          type: STATE_TYPES.login,
          cookieName: LOGIN_STATE_COOKIE,
          cookiePath: LOGIN_STATE_COOKIE_PATH,
          state: typeof req.query.state === "string" ? req.query.state : ""
        });
      } catch {
        // Unknown or used state: the answer is the same.
      }
      return res.redirect("/login?error=oauth_cancelled");
    }
    try {
      const parsed = oauthCallbackSchema.parse(req.query);
      stateData = await consumeOAuthState({
        req,
        res,
        type: STATE_TYPES.login,
        cookieName: LOGIN_STATE_COOKIE,
        cookiePath: LOGIN_STATE_COOKIE_PATH,
        state: parsed.state
      });
      if (stateData.provider !== provider) {
        return res.redirect("/login?error=oauth_state_invalid");
      }
    } catch {
      return res.redirect("/login?error=oauth_state_invalid");
    }

    return passport.authenticate(provider, { session: false }, async (err, profile) => {
      try {
        if (err || !profile) {
          return res.redirect("/login?error=oauth_failed");
        }

        const user = await upsertOAuthUser(profile);
        if (user.suspended_at) {
          return res.redirect("/login?error=account_suspended");
        }
        await applyAdminBootstrap(user);

        // The team is resolved at exchange time (active team if still a member). The code is
        // bound to the session generation and OAuth link seen now: if the account is signed out
        // everywhere or its link moves before the code is exchanged, the exchange is refused.
        const authCode = await issueOAuthCode({
          userId: user.id,
          sessionVersion: sessionVersionOf(user),
          provider: user.oauth_provider ?? null,
          providerId: user.oauth_provider_id ?? null
        });

        return res.redirect(`/login?auth_code=${encodeURIComponent(authCode)}`);
      } catch (cbErr) {
        if (cbErr instanceof OAuthLoginError) {
          return res.redirect(`/login?error=${cbErr.code}`);
        }
        logger.error({ err: cbErr, provider }, "OAuth callback processing error");
        return res.redirect("/login?error=oauth_callback_failed");
      }
    })(req, res, next);
  };
}

/**
 * Sign-in routes. With `local` (local mode, one built-in user) only /profile is mounted: no
 * providers, refresh, code exchange or team switching.
 */
export function authRoutes({ local = false } = {}) {
  const router = Router();
  if (local) {
    router.get("/profile", authenticate, profileHandler);
    return router;
  }

  setupPassportStrategies();

  router.post(
    "/refresh",
    validate(async (req, res) => {
      const data = refreshSchema.parse(req.body);
      const hash = hashRefreshToken(data.refreshToken);
      const invalid = { status: 401, body: { error: "Invalid or expired refresh token" } };

      const outcome = await transaction(async (client) => {
        // Lock the owner's users row before the token row, the order every revocation takes
        // (users row, then its refresh tokens); the opposite order can deadlock with one.
        const owner = await client.query(
          "SELECT user_id FROM refresh_tokens WHERE token_hash = $1",
          [hash]
        );
        const ownerId = owner.rows[0]?.user_id;
        if (ownerId) await lockSessionVersion(ownerId, client);

        // Atomic claim: a refresh token is used exactly once. Used rows are kept until
        // they expire so a second presentation can be recognised as reuse.
        const result = ownerId
          ? await client.query(
              `UPDATE refresh_tokens SET used_at = NOW()
               WHERE token_hash = $1 AND expires_at > NOW() AND used_at IS NULL
               RETURNING user_id, session_version`,
              [hash]
            )
          : { rows: [] };

        if (result.rows.length === 0) {
          const reused = await client.query(
            `SELECT user_id, used_at > NOW() - make_interval(secs => $2) AS within_grace
             FROM refresh_tokens
             WHERE token_hash = $1 AND used_at IS NOT NULL AND expires_at > NOW()`,
            [hash, REFRESH_REUSE_GRACE_SEC]
          );
          const reuse = reused.rows[0];
          if (reuse && !reuse.within_grace) {
            // A rotated token came back: it was stolen or leaked. Sign the user out everywhere,
            // live access tokens included (session_version bump), not just the refresh tokens.
            await revokeUserCredentials(reuse.user_id, client);
            return { ...invalid, revokedUserId: reuse.user_id };
          }
          return rollback(invalid);
        }

        const userId = result.rows[0].user_id;
        const userResult = await client.query(
          "SELECT email, display_name, suspended_at, session_version FROM users WHERE id = $1",
          [userId]
        );
        if (userResult.rows.length === 0) return invalid;
        if (userResult.rows[0].suspended_at) {
          return { status: 403, body: { error: "Account is suspended" } };
        }
        // The token was issued in a generation that has since been revoked (it survived the
        // revocation's delete, e.g. by being stored concurrently): it must not adopt the current
        // one. The consumed row stays consumed. issueSession re-checks this under the row lock.
        const tokenSessionVersion = Number(result.rows[0].session_version);
        if (tokenSessionVersion !== Number(userResult.rows[0].session_version)) {
          return { ...invalid, staleUserId: userId };
        }

        const user = {
          id: userId,
          email: userResult.rows[0].email,
          session_version: tokenSessionVersion
        };
        await client.query(
          "DELETE FROM refresh_tokens WHERE user_id = $1 AND expires_at <= NOW()",
          [user.id]
        );
        const membership = await resolveSessionTeam(
          user.id,
          userResult.rows[0].display_name,
          client
        );
        const tokens = await issueSession(user, membership, client);
        return {
          status: 200,
          body: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }
        };
      });

      if (outcome.revokedUserId) {
        logger.warn(
          { userId: outcome.revokedUserId },
          "Refresh token reuse detected; sessions revoked"
        );
      }
      if (outcome.staleUserId) {
        logger.warn(
          { userId: outcome.staleUserId },
          "Refresh token from a revoked session generation refused"
        );
      }
      res.status(outcome.status).json(outcome.body);
    })
  );

  router.get("/google", handleOAuthProvider("google"));
  router.get("/google/callback", handleOAuthCallback("google"));
  router.get("/github", handleOAuthProvider("github"));
  router.get("/github/callback", handleOAuthCallback("github"));
  router.get("/intuit", handleOAuthProvider("intuit"));
  router.get("/intuit/callback", handleOAuthCallback("intuit"));

  router.post(
    "/oauth/exchange",
    validate(async (req, res) => {
      const data = oauthExchangeSchema.parse(req.body);

      // Read and delete in one step: a code can be exchanged once (no replay).
      const tokenData = oauthCodes.take(data.code);
      if (!tokenData) {
        return res.status(400).json({ error: "OAuth code is invalid or expired" });
      }

      // One transaction that locks the users row first: two first sign-ins exchanging at once
      // take turns, so the second finds the team the first created instead of creating another.
      const outcome = await transaction(async (client) => {
        const userResult = await client.query(
          "SELECT * FROM users WHERE id = $1 FOR NO KEY UPDATE",
          [tokenData.userId]
        );
        if (userResult.rows.length === 0) {
          return rollback({ status: 404, body: { error: "User not found" } });
        }
        const user = userResult.rows[0];
        if (user.suspended_at) {
          return rollback({ status: 403, body: { error: "Account is suspended" } });
        }
        if (!oauthCodeStillValid(tokenData, user)) {
          logger.warn({ userId: user.id }, "OAuth code refused: account changed since sign-in");
          return rollback({ status: 400, body: { error: "OAuth code is invalid or expired" } });
        }
        const membership = await resolveSessionTeam(user.id, user.display_name, client);
        const { accessToken, refreshToken } = await issueSession(user, membership, client);
        return {
          status: 200,
          body: buildAuthResponse(user, membership.teamId, accessToken, refreshToken)
        };
      });

      res.status(outcome.status).json(outcome.body);
    })
  );

  // ── Team switching ─────────────────────────────────────────────────────────
  router.post(
    "/switch-team",
    authenticate,
    validate(async (req, res) => {
      const data = switchTeamSchema.parse(req.body);
      const membership = await query(
        "SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 LIMIT 1",
        [data.teamId, req.user.id]
      );
      if (membership.rows.length === 0) {
        return res.status(403).json({ error: "You are not a member of that team" });
      }
      const userResult = await query("SELECT * FROM users WHERE id = $1", [req.user.id]);
      const user = userResult.rows[0];
      if (!user) return res.status(404).json({ error: "User not found" });

      await setActiveTeam(user.id, data.teamId);
      // Issue for the generation this request authenticated in: a revocation that completed
      // since then makes the guarded refresh-token insert fail (401) instead of minting a new
      // 30-day session from a dead access token.
      const { accessToken, refreshToken } = await issueSession(
        { ...user, session_version: req.user.sessionVersion },
        { teamId: data.teamId, role: membership.rows[0].role }
      );
      res.json({
        ...buildAuthResponse(user, data.teamId, accessToken, refreshToken),
        role: membership.rows[0].role
      });
    })
  );

  router.get("/profile", authenticate, profileHandler);

  return router;
}

/** The signed-in user, plus the team this request acts in (local mode has no token to read). */
async function profileHandler(req, res, next) {
  try {
    const result = await query(
      "SELECT id, email, display_name, avatar_url, is_admin, created_at FROM users WHERE id = $1",
      [req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "User not found" });
    res.json({ ...result.rows[0], team_id: req.user.teamId });
  } catch (err) {
    next(err);
  }
}

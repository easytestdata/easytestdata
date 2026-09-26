import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { getQueryItems } from "@easytestdata/qbo-client";
import { authenticate, requireTeamManager } from "../middleware/auth.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { decryptTokenPair, encryptTokenPair } from "../crypto/tokens.js";
import { query as dbQuery, rollback, transaction } from "../db/pool.js";
import {
  withLockedConnection,
  ConnectionLockBusyError,
  SANDBOX_DISCONNECTED_MESSAGE
} from "../services/connection-lock.js";
import { beginOAuthState, consumeOAuthState } from "../auth/oauth-state.js";
import { STATE_TYPES } from "../auth/tokens.js";
import { getLimits } from "../services/limits.js";
import { lockConnectingMember, lockRealmConnection } from "../services/connection-guard.js";
import {
  disconnectConnection,
  DISCONNECT_BUSY_MESSAGE
} from "../services/connection-disconnect.js";
import { insertLimitedJob } from "../services/job-enqueue.js";
import { getQboCredentials, qboNotConfiguredError } from "../services/app-settings.js";
import { notifyJobQueued } from "../workers/runner.js";

const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  realmId: z.string().min(1)
});

const QBO_HTTP_TIMEOUT_MS = 30_000;

const QBO_STATE_COOKIE = "eztd_qbo_connect";
const QBO_STATE_COOKIE_PATH = "/api/v1/connections";

/**
 * Stores a callback's tokens: updates the team's row for the realm (reconnecting a disconnected
 * one on the same row, so its jobs and load history stay attached), or inserts a new one. Follows
 * services/connection-guard.js's rule: under the team row and connection row locks it re-checks
 * that the user who started the flow is still an unsuspended member of the team (the state is up
 * to 10 minutes old, and the token exchange ran since), holding their membership until commit, so
 * a removal or suspension either waits for this store or makes it refuse. The limit counts
 * connected sandboxes only and applies whenever the store would add one (a new realm or a
 * disconnected one coming back), so a team at the limit can still reconnect a connected sandbox.
 * Returns "stored", "not_member" or "limit".
 *
 * A reconnect leaves the row as a new connection would be: connected now, never used
 * (last_used_at NULL), so token health counts from the new tokens, not an old last use. It does
 * not take the in-process connection lock: a job running on the old tokens keeps them in memory,
 * and its next refresh is not persisted (buildLockedQboClient's compare-and-swap misses), so the
 * newer tokens stored here win without making the user's callback wait for the job.
 */
async function storeConnection({ teamId, userId, realmId, companyName, baseUrl, encrypted }) {
  const limits = getLimits();
  return transaction(async (client) => {
    const row = await lockRealmConnection(client, { teamId, realmId });
    if (!(await lockConnectingMember(client, { teamId, userId }))) return rollback("not_member");

    if (limits.connections !== -1 && (!row || row.disconnected_at)) {
      const count = await client.query(
        `SELECT COUNT(*)::int AS count FROM qbo_connections
         WHERE team_id = $1 AND disconnected_at IS NULL`,
        [teamId]
      );
      if (Number(count.rows[0]?.count || 0) >= limits.connections) return rollback("limit");
    }

    if (row) {
      await client.query(
        `UPDATE qbo_connections
         SET access_token_enc = $1, refresh_token_enc = $2, token_iv = $3,
             company_name = $4, base_url = $5, connected_at = NOW(), last_used_at = NULL,
             disconnected_at = NULL
         WHERE id = $6`,
        [
          encrypted.access_token_enc,
          encrypted.refresh_token_enc,
          encrypted.token_iv,
          companyName,
          baseUrl,
          row.id
        ]
      );
      return "stored";
    }
    await client.query(
      `INSERT INTO qbo_connections (team_id, realm_id, company_name, access_token_enc, refresh_token_enc, token_iv, base_url, connected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        teamId,
        realmId,
        companyName,
        encrypted.access_token_enc,
        encrypted.refresh_token_enc,
        encrypted.token_iv,
        baseUrl
      ]
    );
    return "stored";
  });
}

/** 409 for a route that would use a sandbox the team has disconnected. */
function sendDisconnected(res, extra = {}) {
  return res.status(409).json({ ...extra, error: SANDBOX_DISCONNECTED_MESSAGE });
}

export function connectionRoutes() {
  const router = Router();

  router.get("/authorize", authenticate, async (req, res, next) => {
    try {
      const credentials = await getQboCredentials();
      if (!credentials) throw qboNotConfiguredError();
      // No connection-limit check here: reconnecting an existing sandbox never adds one, and
      // which sandbox the user picks is only known at the callback (storeConnection).

      const mode = req.query.mode === "popup" ? "popup" : "redirect";
      // Bound to this browser (httpOnly cookie) and single-use, so a callback URL started by
      // someone else cannot connect a sandbox into their team from this browser.
      const state = await beginOAuthState({
        res,
        type: STATE_TYPES.qboConnect,
        cookieName: QBO_STATE_COOKIE,
        cookiePath: QBO_STATE_COOKIE_PATH,
        payload: { userId: req.user.id, teamId: req.user.teamId, mode }
      });

      const params = new URLSearchParams({
        client_id: credentials.clientId,
        redirect_uri: config.qbo.redirectUri,
        response_type: "code",
        scope: "com.intuit.quickbooks.accounting",
        state
      });

      res.json({ url: `https://appcenter.intuit.com/connect/oauth2?${params.toString()}` });
    } catch (err) {
      next(err);
    }
  });

  router.get("/callback", async (req, res) => {
    let stateData;

    function sendScriptPage(script, body) {
      const nonce = crypto.randomBytes(16).toString("base64");
      res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'`);
      res.send(
        `<!DOCTYPE html><html><body>` +
          `<script nonce="${nonce}">${script}</script>` +
          body +
          `</body></html>`
      );
    }

    function sendPopupResult(result) {
      sendScriptPage(
        `if(window.opener){window.opener.postMessage(${JSON.stringify(result)},location.origin)}` +
          `window.close();`,
        `<p>You can close this window.</p>`
      );
    }

    // Without a usable state (expired, forgotten by a restart, used, unbound or missing) the
    // flow's mode is unknown, so the page decides: a popup opened by this app gets the message
    // and closes (its opener is waiting for one), anything else goes to `redirectPath`. Nothing
    // is stored on this path; the mode only picks how the error is shown.
    function sendUnknownModeResult(redirectPath, result) {
      sendScriptPage(
        `var o=null;` +
          `try{if(window.opener&&window.opener.location.origin===location.origin){o=window.opener}}catch(e){}` +
          `if(o){o.postMessage(${JSON.stringify(result)},location.origin);window.close()}` +
          `else{location.replace(${JSON.stringify(redirectPath)})}`,
        `<p><a href="${redirectPath}">Continue</a></p>`
      );
    }

    function respond(redirectPath, popupResult) {
      if (!stateData) return sendUnknownModeResult(redirectPath, popupResult);
      if (stateData.mode === "popup") {
        return sendPopupResult(popupResult);
      }
      return res.redirect(redirectPath);
    }

    try {
      // Declined or cancelled at Intuit (e.g. error=access_denied): no code or realm comes back.
      // Use up the state (it also tells whether this is the popup) and say so.
      if (req.query.error) {
        try {
          stateData = await consumeOAuthState({
            req,
            res,
            type: STATE_TYPES.qboConnect,
            cookieName: QBO_STATE_COOKIE,
            cookiePath: QBO_STATE_COOKIE_PATH,
            state: typeof req.query.state === "string" ? req.query.state : ""
          });
        } catch {
          // Unknown or used state: respond() lets the page pick popup or redirect.
        }
        return respond("/home?error=connect_cancelled", { error: "connect_cancelled" });
      }

      const parsed = callbackQuerySchema.parse(req.query);
      try {
        stateData = await consumeOAuthState({
          req,
          res,
          type: STATE_TYPES.qboConnect,
          cookieName: QBO_STATE_COOKIE,
          cookiePath: QBO_STATE_COOKIE_PATH,
          state: parsed.state
        });
      } catch (stateErr) {
        logger.warn({ err: stateErr }, "Rejected QBO OAuth callback state");
        return respond("/home?error=state_invalid", { error: "state_invalid" });
      }

      // The state is up to 10 minutes old. A cheap early refusal for a user who left the team (or
      // was suspended) since, before spending a token exchange; storeConnection re-checks it
      // atomically with the write, which is what decides.
      const member = await dbQuery(
        `SELECT 1 FROM team_members tm JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = $1 AND tm.user_id = $2 AND u.suspended_at IS NULL
         LIMIT 1`,
        [stateData.teamId, stateData.userId]
      );
      if (member.rows.length === 0) {
        return respond("/home?error=not_team_member", { error: "not_team_member" });
      }

      // The keys can be gone since the flow started (e.g. local keys that no longer decrypt).
      const credentials = await getQboCredentials();
      if (!credentials) {
        return respond("/home?error=qbo_not_configured", { error: "qbo_not_configured" });
      }

      const tokenRes = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: parsed.code,
          redirect_uri: config.qbo.redirectUri
        }),
        signal: AbortSignal.timeout(QBO_HTTP_TIMEOUT_MS)
      });

      if (!tokenRes.ok) {
        return respond("/home?error=token_exchange_failed", {
          error: "token_exchange_failed"
        });
      }

      const tokens = await tokenRes.json();
      const encrypted = encryptTokenPair(tokens.access_token, tokens.refresh_token);

      const baseUrl = "https://sandbox-quickbooks.api.intuit.com";
      let companyName = `Company ${parsed.realmId}`;

      // Company-info is best-effort metadata; a slow/failed lookup (including an
      // AbortSignal timeout) must not discard the tokens we already exchanged.
      try {
        const companyRes = await fetch(
          `${baseUrl}/v3/company/${parsed.realmId}/companyinfo/${parsed.realmId}?minorversion=65`,
          {
            headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json" },
            signal: AbortSignal.timeout(QBO_HTTP_TIMEOUT_MS)
          }
        );

        if (companyRes.ok) {
          const companyData = await companyRes.json();
          companyName = companyData.CompanyInfo?.CompanyName || companyName;
        }
      } catch (companyErr) {
        logger.warn(
          { err: companyErr, realmId: parsed.realmId },
          "QBO company-info lookup failed; using fallback company name"
        );
      }

      // Membership (the state's user may have left the team or been suspended since the flow
      // started) is checked where the tokens are stored, atomically with the write.
      const stored = await storeConnection({
        teamId: stateData.teamId,
        userId: stateData.userId,
        realmId: parsed.realmId,
        companyName,
        baseUrl,
        encrypted
      });
      if (stored === "not_member") {
        return respond("/home?error=not_team_member", { error: "not_team_member" });
      }
      if (stored === "limit") {
        return respond("/home?error=connection_limit_reached", {
          error: "connection_limit_reached"
        });
      }

      respond("/home?connected=true", { connected: true });
    } catch (err) {
      logger.error({ err }, "QBO OAuth callback error");
      respond("/home?error=callback_failed", { error: "callback_failed" });
    }
  });

  router.use(authenticate);

  router.get("/", async (req, res, next) => {
    try {
      // has_prior_load: the sandbox holds data from an earlier load (completed, or failed with
      // records left), so the web app offers to clear it first. Computed here, not from the
      // capped job list, so an old load is never missed.
      const result = await dbQuery(
        `SELECT c.id, c.realm_id, c.company_name, c.base_url, c.connected_at, c.last_used_at,
                EXISTS (
                  SELECT 1 FROM jobs j
                  WHERE j.connection_id = c.id AND j.team_id = c.team_id AND j.type = 'load'
                    AND j.status IN ('completed', 'failed_with_orphans')
                ) AS has_prior_load
         FROM qbo_connections c
         WHERE c.team_id = $1 AND c.disconnected_at IS NULL`,
        [req.user.teamId]
      );
      const rows = result.rows.map((conn) => {
        const lastActivity = conn.last_used_at || conn.connected_at;
        const daysSince = lastActivity
          ? Math.floor((Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24))
          : Infinity;
        let tokenHealth = "ok";
        if (daysSince > 100) tokenHealth = "expired";
        else if (daysSince > 80) tokenHealth = "warning";
        return { ...conn, tokenHealth };
      });
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/test", async (req, res, _next) => {
    try {
      const result = await dbQuery("SELECT * FROM qbo_connections WHERE id = $1 AND team_id = $2", [
        req.params.id,
        req.user.teamId
      ]);
      if (result.rows.length === 0) {
        return res.status(404).json({ ok: false, error: "Connection not found" });
      }

      const conn = result.rows[0];
      if (conn.disconnected_at) return sendDisconnected(res, { ok: false });

      // Serialize all QBO access through the shared per-connection lock and build
      // the client from a row re-read UNDER the lock, so a concurrent
      // worker/keepalive refresh cannot leave us using a rotated-out token.
      const company = await withLockedConnection(conn.id, async ({ client }) => {
        const response = await client.query("select * from CompanyInfo");
        await dbQuery("UPDATE qbo_connections SET last_used_at = NOW() WHERE id = $1", [conn.id]);
        // A `select` answers with a list of CompanyInfo records (one per company).
        return getQueryItems(response, "CompanyInfo")[0] || null;
      });

      res.json({ ok: true, companyName: company?.CompanyName || conn.company_name });
    } catch (err) {
      if (err instanceof ConnectionLockBusyError) {
        return res.status(409).json({ ok: false, error: "Connection is busy (a job is running)." });
      }
      // Raw QBO/driver messages can include request details; log them, return a generic error.
      logger.warn({ err, connectionId: req.params.id }, "QBO connection test failed");
      res.status(400).json({
        ok: false,
        error: "Could not reach this QuickBooks sandbox. Try reconnecting it."
      });
    }
  });

  router.get("/:id/health", async (req, res, next) => {
    try {
      const result = await dbQuery(
        `SELECT id, connected_at, last_used_at, access_token_enc, refresh_token_enc, token_iv,
                disconnected_at
         FROM qbo_connections WHERE id = $1 AND team_id = $2`,
        [req.params.id, req.user.teamId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Connection not found" });
      }

      const conn = result.rows[0];
      if (conn.disconnected_at) return sendDisconnected(res);
      const warnings = [];
      const lastActivity = conn.last_used_at || conn.connected_at;
      const daysSinceActivity = lastActivity
        ? Math.floor((Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24))
        : Infinity;

      if (daysSinceActivity > 100) {
        return res.json({
          connectionId: conn.id,
          status: "expired",
          daysSinceActivity,
          warnings: [
            "QBO refresh token has expired (>100 days inactive). Please reconnect your sandbox."
          ]
        });
      }

      if (daysSinceActivity > 80) {
        warnings.push(
          `Access expires in about ${100 - daysSinceActivity} days unless the sandbox is used. Test the connection to renew it.`
        );
      }

      // Passive check: no lock, no network call. But still verify the stored
      // token is READABLE — a corrupt row or TOKEN_ENCRYPTION_KEY mismatch makes
      // the connection unusable, so report it as needing reconnect rather than
      // healthy (a later job would otherwise fail while building the client). The
      // daily keepalive and real jobs perform the actual token refresh under the lock.
      try {
        decryptTokenPair(conn.access_token_enc, conn.refresh_token_enc, conn.token_iv);
      } catch {
        return res.json({
          connectionId: conn.id,
          status: "expired",
          daysSinceActivity,
          warnings: ["Stored credentials could not be read. Please reconnect your sandbox."]
        });
      }

      res.json({
        connectionId: conn.id,
        status: warnings.length > 0 ? "warning" : "healthy",
        daysSinceActivity,
        warnings
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/purge", async (req, res, next) => {
    try {
      const tag = String(req.body?.tag || "EZTD")
        .trim()
        .toUpperCase();
      const purgeMode = req.body?.mode === "all" ? "all" : "generated";
      // Deleting every transaction in the sandbox (not just generated data) is owner/admin only.
      if (purgeMode === "all" && !["owner", "admin"].includes(req.user.role)) {
        return res.status(403).json({
          error: "Only a team owner or admin can erase all data in a sandbox."
        });
      }
      const purgeConfig = {
        connectionId: req.params.id,
        templateId: "professional-services",
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        totalRevenue: 100000,
        targetEbitda: 20000,
        customerCount: 1,
        employeeCount: 0,
        tag,
        purgeMode
      };

      // Purges never count toward the monthly load limit but follow the one-active-QBO-job rule; the
      // insert refuses a missing (404) or disconnected (409) connection under its row lock.
      const job = await insertLimitedJob({
        teamId: req.user.teamId,
        connectionId: req.params.id,
        type: "purge",
        config: purgeConfig,
        createdBy: req.user.id
      });
      notifyJobQueued();

      res.status(201).json(job);
    } catch (err) {
      next(err);
    }
  });

  // Disconnect keeps the row (history) and is refused (409) while a job or the lock uses the
  // sandbox; see services/connection-disconnect.js. Unknown ids answer deleted (idempotent).
  router.delete("/:id", requireTeamManager, async (req, res, next) => {
    try {
      const outcome = await disconnectConnection(req.params.id, { teamId: req.user.teamId });
      if (outcome === "busy") return res.status(409).json({ error: DISCONNECT_BUSY_MESSAGE });
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

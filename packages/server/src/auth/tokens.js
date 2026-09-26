import jwt from "jsonwebtoken";
import { config } from "../config.js";

// Every JWT this server signs carries a distinct audience + typ so one kind of token can never
// be replayed as another (e.g. an OAuth state token presented as an access token).
export const ACCESS_TOKEN_AUDIENCE = "easytestdata:access";
export const ACCESS_TOKEN_TYPE = "access";
export const OAUTH_STATE_AUDIENCE = "easytestdata:oauth-state";
export const STATE_TYPES = Object.freeze({
  login: "oauth_login_state",
  qboConnect: "qbo_connect_state"
});

/** Signs a short-lived access token. `payload` must include `sub`. */
export function signAccessToken(payload, options = {}) {
  return jwt.sign({ ...payload, typ: ACCESS_TOKEN_TYPE }, config.jwt.secret, {
    issuer: config.jwt.issuer,
    audience: ACCESS_TOKEN_AUDIENCE,
    expiresIn: config.jwt.accessTokenExpiry,
    ...options
  });
}

/**
 * Verifies an access token (signature, issuer, expiry, audience and typ). Throws a
 * JsonWebTokenError for anything that is not an access token.
 */
export function verifyAccessToken(token) {
  const payload = jwt.verify(token, config.jwt.secret, {
    issuer: config.jwt.issuer,
    audience: ACCESS_TOKEN_AUDIENCE
  });
  if (payload?.typ !== ACCESS_TOKEN_TYPE || !payload.sub) {
    throw new jwt.JsonWebTokenError("invalid token type");
  }
  return payload;
}

/**
 * An access token is only valid for the session generation it was issued in: revoking a user's
 * credentials bumps users.session_version, and every token minted earlier carries the old `sv`.
 * Every access token is minted with `sv`; a token without the claim is never accepted.
 */
export function sessionVersionMatches(payload, user) {
  const claimed = payload?.sv;
  if (typeof claimed !== "number" || !Number.isInteger(claimed)) return false;
  return claimed === Number(user?.session_version ?? 0);
}

export function signStateToken(type, payload, expiresIn = "10m") {
  return jwt.sign({ ...payload, typ: type }, config.jwt.secret, {
    issuer: config.jwt.issuer,
    audience: OAUTH_STATE_AUDIENCE,
    expiresIn
  });
}

export function verifyStateToken(type, token) {
  const payload = jwt.verify(token, config.jwt.secret, {
    issuer: config.jwt.issuer,
    audience: OAUTH_STATE_AUDIENCE
  });
  if (payload?.typ !== type) {
    throw new jwt.JsonWebTokenError("invalid state type");
  }
  return payload;
}

import crypto from "crypto";
import { config } from "../config.js";
import { oauthStates } from "../state/memory.js";
import { signStateToken, verifyStateToken } from "./tokens.js";

// OAuth `state` values are bound to the browser that started the flow (an httpOnly cookie holds
// the same random nonce as the signed state) and are single-use (taken from process memory).
// Without this, an attacker could hand a victim a callback URL carrying the attacker's
// state/code and either log the victim into the attacker's account or connect the victim's
// sandbox into the attacker's team.

const STATE_TTL_SEC = 10 * 60;

export class OAuthStateError extends Error {
  constructor(message = "OAuth state is invalid") {
    super(message);
    this.name = "OAuthStateError";
  }
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (!name || name in out) continue;
    const value = part.slice(idx + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

// Secure follows the app URL's scheme, not NODE_ENV: local mode runs NODE_ENV=production over
// http://localhost, where Safari drops Secure cookies (Chrome and Firefox exempt localhost).
function cookieOptions(path) {
  return { httpOnly: true, sameSite: "lax", secure: config.appUrl.startsWith("https:"), path };
}

function stateKey(type, nonce) {
  return `${type}:${nonce}`;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Starts an OAuth flow: records a single-use nonce in memory, sets it as a browser-bound cookie
 * and returns the signed state token to send to the provider.
 */
export async function beginOAuthState({ res, type, cookieName, cookiePath, payload = {} }) {
  const nonce = crypto.randomBytes(24).toString("hex");
  oauthStates.set(stateKey(type, nonce), true, STATE_TTL_SEC * 1000);
  res.cookie(cookieName, nonce, { ...cookieOptions(cookiePath), maxAge: STATE_TTL_SEC * 1000 });
  return signStateToken(type, { ...payload, nonce }, `${STATE_TTL_SEC}s`);
}

/**
 * Validates and consumes a callback's state: signature/aud/typ, cookie binding, and single use.
 * Always clears the cookie. Throws OAuthStateError on any failure.
 */
export async function consumeOAuthState({ req, res, type, cookieName, cookiePath, state }) {
  res.clearCookie(cookieName, cookieOptions(cookiePath));

  let payload;
  try {
    payload = verifyStateToken(type, state);
  } catch {
    throw new OAuthStateError();
  }

  const cookieNonce = parseCookies(req.headers.cookie)[cookieName];
  if (!payload.nonce || !safeEqual(cookieNonce, payload.nonce)) {
    throw new OAuthStateError("OAuth state is not bound to this browser");
  }

  if (!oauthStates.take(stateKey(type, payload.nonce))) {
    throw new OAuthStateError("OAuth state was already used or has expired");
  }
  return payload;
}

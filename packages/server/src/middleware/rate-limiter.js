import { config } from "../config.js";
import { authRoutePaths, normalizeRoutePath } from "../http/route-path.js";
import { rateLimits } from "../state/memory.js";

const IP_LIMIT = config.rateLimit.ipLimit;
const AUTH_LIMIT = config.rateLimit.authLimit;

const WINDOW_MS = config.rateLimit.windowSec * 1000;
const AUTH_WINDOW_MS = config.rateLimit.authWindowSec * 1000;
// Auth-router routes that share the strict auth bucket, under every prefix the router answers
// on: the two that take a one-time credential.
const SENSITIVE_AUTH_ROUTES = ["/refresh", "/oauth/exchange"];
export const SENSITIVE_AUTH_PATHS = new Set(authRoutePaths(SENSITIVE_AUTH_ROUTES));

// Spelling variants (`/auth/REFRESH/`) reach the same handler, so compare the normalized path.
function isSensitiveAuthPath(req) {
  return SENSITIVE_AUTH_PATHS.has(normalizeRoutePath(req.path));
}

/** Per-IP fixed-window limits kept in process memory, plus a stricter bucket for auth routes. */
export function rateLimiter() {
  return (req, res, next) => {
    // req.ip honours the TRUST_PROXY setting, so behind a trusted proxy it is the real client.
    const ip = req.ip || req.socket?.remoteAddress || "unknown";

    if (isSensitiveAuthPath(req) && !rateLimits.hit(`auth:${ip}`, AUTH_LIMIT, AUTH_WINDOW_MS)) {
      return res.status(429).json({ error: "Too many authentication attempts. Try again later." });
    }
    if (!rateLimits.hit(`ip:${ip}`, IP_LIMIT, WINDOW_MS)) {
      return res.status(429).json({ error: "Rate limit exceeded. Please try again later." });
    }
    return next();
  };
}

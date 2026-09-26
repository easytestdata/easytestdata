/**
 * Express routes case-insensitively and ignores trailing (and repeated) slashes, so
 * `/auth/REFRESH/` reaches the refresh handler. Anything that compares `req.path` against a list of
 * routes (the rate limiter's sensitive set) must normalize the same way first, or a spelling
 * variant would skip the check while still hitting the route.
 */
export function normalizeRoutePath(path) {
  let value = String(path || "/");
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep the raw path; it will not match any route either.
  }
  value = value.toLowerCase().replace(/\/{2,}/g, "/");
  while (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

/** Prefixes the auth router answers under. */
export const AUTH_ROUTE_PREFIXES = Object.freeze(["/api/v1/auth"]);

/** Expands auth-router-relative routes ("/login") to every prefix they are reachable under. */
export function authRoutePaths(routes) {
  return AUTH_ROUTE_PREFIXES.flatMap((prefix) => routes.map((route) => `${prefix}${route}`));
}

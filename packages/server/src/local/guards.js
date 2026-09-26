/**
 * Local mode has no sign-in, so any page open in the same browser could try to call the local
 * API. These checks run before everything else and refuse what a foreign page can send:
 *
 * - A Host other than the app's own (DNS rebinding: a foreign hostname resolving to 127.0.0.1
 *   still sends its own Host).
 * - Anything relayed by a proxy (Forwarded / X-Forwarded-* / X-Real-IP): browsers never send
 *   these to localhost, so they mean the app is exposed through a reverse proxy it must not be
 *   behind. (The Vite dev proxy adds none: `xfwd` stays off.)
 * - A state-changing request with a foreign Origin.
 * - A state-changing request without `X-EasyTestData: 1`. A cross-site page cannot add a custom
 *   header without a CORS preflight, which local mode never grants, so form posts and no-cors
 *   fetches are refused even when the browser sends no Origin.
 *
 * GET, HEAD and OPTIONS pass the header checks: no endpoint changes data on a GET except the
 * Intuit OAuth callback, which verifies its signed, browser-bound, single-use state. The one
 * exception is `GET /connections/authorize`, which allocates an OAuth state entry in memory: the
 * app calls it with fetch (so it sends the header), and requiring the header there keeps a
 * foreign page from filling that store with credentialed or no-cors GETs.
 */
import { normalizeRoutePath } from "../http/route-path.js";

const PROXY_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"];
// GETs that allocate server state, compared after normalizing the path the way Express matches.
const STATEFUL_GETS = new Set(["/api/v1/connections/authorize"]);

export function localRequestGuards({ port, appUrl }) {
  const publicUrl = new URL(appUrl); // http://localhost:<port>, or the dev server in development
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, publicUrl.host]);
  const origins = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    publicUrl.origin
  ]);
  return (req, res, next) => {
    // DNS rebinding: a foreign hostname resolving to 127.0.0.1 still sends its own Host.
    if (!hosts.has(String(req.headers.host || "").toLowerCase())) {
      return res.status(403).json({ error: "EasyTestData only answers on localhost." });
    }
    if (PROXY_HEADERS.some((header) => header in req.headers)) {
      return res.status(403).json({ error: "EasyTestData local mode cannot run behind a proxy." });
    }
    const safe =
      (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") &&
      !(req.method !== "OPTIONS" && STATEFUL_GETS.has(normalizeRoutePath(req.path)));
    if (safe) return next(); // SPA pages, assets and the Intuit OAuth callback are GETs
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) {
      return res.status(403).json({ error: "Cross-site requests are not allowed." });
    }
    // A cross-site page cannot add a custom header without a CORS preflight, which local mode
    // never allows: this blocks form posts and no-cors fetches even when Origin is absent. It
    // applies to every unsafe request, whatever the path's spelling (Express matches /API/ too).
    if (req.headers["x-easytestdata"] !== "1") {
      return res.status(403).json({ error: "Missing X-EasyTestData header." });
    }
    return next();
  };
}

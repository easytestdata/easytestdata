import crypto from "crypto";
import pinoHttp from "pino-http";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Drops the query string from a URL before it is logged or reported. Query strings carry
 * one-time credentials (?auth_code=, invite tokens, OAuth codes/state).
 */
export function stripQuery(url) {
  if (typeof url !== "string") return url;
  const idx = url.indexOf("?");
  return idx === -1 ? url : `${url.slice(0, idx)}?[redacted]`;
}

/** Request headers for a log line: the Referer (the page the browser is on) loses its query. */
function loggableHeaders(headers) {
  if (!headers?.referer) return headers;
  return { ...headers, referer: stripQuery(headers.referer) };
}

// Span/trace data keys that hold a URL (query stripped) or a bare query (dropped).
const SPAN_URL_KEYS = ["url", "url.full", "http.url", "http.target"];
const SPAN_QUERY_KEYS = ["url.query", "http.query"];

function scrubSpanData(data) {
  if (!data || typeof data !== "object") return data;
  const scrubbed = { ...data };
  for (const key of SPAN_URL_KEYS) {
    if (typeof scrubbed[key] === "string") scrubbed[key] = stripQuery(scrubbed[key]);
  }
  for (const key of SPAN_QUERY_KEYS) delete scrubbed[key];
  return scrubbed;
}

function scrubSpan(span) {
  if (!span || typeof span !== "object") return span;
  const scrubbed = { ...span };
  // An HTTP span's description is "GET <url>".
  if (typeof scrubbed.description === "string") {
    scrubbed.description = stripQuery(scrubbed.description);
  }
  if (scrubbed.data) scrubbed.data = scrubSpanData(scrubbed.data);
  return scrubbed;
}

/**
 * Sentry `beforeSend` and `beforeSendTransaction`: an event carries the request URL, its query
 * string and headers (the Referer included), and a transaction also its spans' and trace's URLs;
 * none of them may carry the query's credentials.
 */
export function scrubSentryEvent(event) {
  if (!event || typeof event !== "object") return event;
  const scrubbed = { ...event };
  const req = event.request;
  if (req) {
    scrubbed.request = { ...req, url: stripQuery(req.url), headers: loggableHeaders(req.headers) };
    delete scrubbed.request.query_string;
  }
  if (Array.isArray(event.spans)) scrubbed.spans = event.spans.map(scrubSpan);
  if (event.contexts?.trace) {
    scrubbed.contexts = { ...event.contexts, trace: scrubSpan(event.contexts.trace) };
  }
  return scrubbed;
}

function originOf(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** Where Google and GitHub serve the profile pictures shown as users' avatars. */
const AVATAR_ORIGINS = [
  "https://lh3.googleusercontent.com",
  "https://avatars.githubusercontent.com"
];

/**
 * Builds the production Content-Security-Policy: the app itself, sign-in providers' avatar images
 * and the ingest origin of each configured Sentry DSN. No analytics hosts.
 */
export function buildContentSecurityPolicy({ sentryDsns = [] } = {}) {
  const scriptSrc = ["'self'"];
  const imgSrc = ["'self'", "data:", ...AVATAR_ORIGINS];
  const connectSrc = ["'self'"];

  for (const dsn of sentryDsns) {
    const origin = originOf(dsn);
    if (origin && !connectSrc.includes(origin)) connectSrc.push(origin);
  }

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imgSrc.join(" ")}`,
    `connect-src ${connectSrc.join(" ")}`
  ].join("; ");
}

/** Applies the TRUST_PROXY setting so req.ip is the real client behind trusted proxies. */
export function applyTrustProxy(app, trustProxy) {
  app.set("trust proxy", trustProxy ?? false);
}

/** Accepts a caller-supplied X-Request-Id only when it is short and plain; else generates one. */
export function requestIdMiddleware() {
  return (req, res, next) => {
    const incoming = req.headers["x-request-id"];
    const requestId =
      typeof incoming === "string" && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : crypto.randomUUID();
    req.id = requestId;
    res.setHeader("X-Request-Id", requestId);
    next();
  };
}

export const REDACTED_LOG_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]'
];

/**
 * pino-http middleware that never logs credentials (auth headers, cookies, query strings of the
 * URL and of the Referer).
 */
export function createHttpLogger(logger, { verbose = false } = {}) {
  return pinoHttp({
    logger,
    genReqId: (req) => req.id,
    redact: { paths: REDACTED_LOG_PATHS, censor: "[REDACTED]" },
    autoLogging: {
      ignore: (req) =>
        req.url?.startsWith("/health") ||
        /\.(css|js|svg|png|ico|woff2?|map)(\?.*)?$/.test(req.url) ||
        req.url?.startsWith("/.well-known")
    },
    serializers: verbose
      ? {
          req: (req) => ({
            id: req.id,
            method: req.method,
            url: stripQuery(req.url),
            headers: loggableHeaders(req.headers),
            remoteAddress: req.remoteAddress,
            remotePort: req.remotePort
          })
        }
      : {
          req: (req) => ({ method: req.method, url: stripQuery(req.url) }),
          res: (res) => ({ statusCode: res.statusCode })
        }
  });
}

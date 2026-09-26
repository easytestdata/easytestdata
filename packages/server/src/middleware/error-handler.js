import { STATUS_CODES } from "node:http";
import * as Sentry from "@sentry/node";
import { logger } from "../logger.js";
import { AppError, ErrorCode } from "../errors.js";
import { stripQuery } from "../http/setup.js";

// Any key that looks like a credential, at any depth: passwords, refresh and OAuth tokens, codes,
// client secrets, keys.
const SENSITIVE_KEY = /pass(word)?|token|secret|authorization|cookie|code|key|otp/i;
const MAX_SANITIZE_DEPTH = 5;

export function sanitizeBody(body, depth = 0) {
  if (!body || typeof body !== "object") return body;
  if (depth >= MAX_SANITIZE_DEPTH) return "[TRUNCATED]";
  if (Array.isArray(body)) return body.map((item) => sanitizeBody(item, depth + 1));
  const sanitized = {};
  for (const [key, value] of Object.entries(body)) {
    sanitized[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeBody(value, depth + 1);
  }
  return sanitized;
}

/**
 * Map any thrown error to the standard response shape.
 */
function resolveError(err) {
  // Already an AppError — use directly
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      code: err.code,
      message: err.message,
      errors: err.errors
    };
  }

  // Postgres invalid_text_representation: a malformed id (e.g. GET /jobs/not-a-uuid) cannot
  // match any row, so answer like a missing row instead of a 500.
  if (err.code === "22P02") {
    return {
      statusCode: 404,
      code: ErrorCode.NOT_FOUND,
      message: "Not found"
    };
  }

  // A request body express.json() refused: the client's mistake, not a crash.
  if (err.type === "entity.too.large") {
    return {
      statusCode: 413,
      code: ErrorCode.PAYLOAD_TOO_LARGE,
      message: "Request body is too large."
    };
  }
  if (err.type === "entity.parse.failed") {
    return {
      statusCode: 400,
      code: ErrorCode.VALIDATION_FAILED,
      message: "Request body is not valid JSON."
    };
  }

  // Errors carrying a status property (from routes, Express or other middleware)
  const status = err.status || err.statusCode || 500;

  if (status === 400 || err.name === "ValidationError") {
    return {
      statusCode: 400,
      code: ErrorCode.VALIDATION_FAILED,
      message: err.message || "Bad request"
    };
  }

  if (status === 401 || err.name === "UnauthorizedError") {
    return {
      statusCode: 401,
      code: ErrorCode.UNAUTHORIZED,
      message: "Unauthorized"
    };
  }

  if (status === 403) {
    return {
      statusCode: 403,
      code: ErrorCode.FORBIDDEN,
      message: err.message || "Forbidden"
    };
  }

  if (status === 404) {
    return {
      statusCode: 404,
      code: ErrorCode.NOT_FOUND,
      message: err.message || "Not found"
    };
  }

  if (status === 409) {
    return {
      statusCode: 409,
      code: ErrorCode.CONFLICT,
      message: err.message || "Conflict"
    };
  }

  if (status === 429) {
    return {
      statusCode: 429,
      code: ErrorCode.RATE_LIMITED,
      message: "Rate limit exceeded. Please try again later."
    };
  }

  // Any other client error express.json() raises (e.g. 415 for an unsupported encoding or
  // charset) keeps its status; its message is replaced by the plain status text.
  if (err.expose && typeof err.type === "string" && status >= 400 && status < 500) {
    return {
      statusCode: status,
      code: ErrorCode.INVALID_INPUT,
      message: STATUS_CODES[status] || "Bad request"
    };
  }

  return {
    statusCode: 500,
    code: ErrorCode.INTERNAL_ERROR,
    message: process.env.NODE_ENV === "production" ? "Internal server error" : err.message
  };
}

export function errorHandler(err, req, res, _next) {
  const resolved = resolveError(err);

  // Log with structured fields
  const logPayload = {
    err,
    method: req.method,
    url: stripQuery(req.originalUrl),
    status: resolved.statusCode,
    requestId: req.id
  };

  if (resolved.statusCode < 500) {
    logger.warn(logPayload, err.message);
  } else {
    logger.error(logPayload, err.message);
    // Report 5xx errors to Sentry if configured
    if (process.env.SENTRY_DSN) {
      Sentry.withScope((scope) => {
        if (req.user) {
          scope.setUser({ id: req.user.id, email: req.user.email });
          scope.setTag("teamId", req.user.teamId);
        }
        scope.setTag("requestId", req.id);
        scope.setExtra("method", req.method);
        scope.setExtra("url", stripQuery(req.originalUrl));
        scope.setExtra("requestBody", sanitizeBody(req.body));
        Sentry.captureException(err);
      });
    }
  }

  const body = {
    statusCode: resolved.statusCode,
    code: resolved.code,
    message: resolved.message,
    // `error` mirrors `message`; clients read either.
    error: resolved.message,
    timestamp: new Date().toISOString(),
    path: stripQuery(req.originalUrl)
  };

  if (resolved.errors) {
    body.errors = resolved.errors;
  }

  res.status(resolved.statusCode).json(body);
}

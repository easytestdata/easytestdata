/**
 * Standardized application errors with machine-readable codes.
 *
 * Error response shape:
 * { statusCode, code, message, errors?, timestamp, path }
 */

export const ErrorCode = /** @type {const} */ ({
  // 400
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INVALID_INPUT: "INVALID_INPUT",

  // 401
  UNAUTHORIZED: "UNAUTHORIZED",
  SESSION_REVOKED: "SESSION_REVOKED",

  // 403
  FORBIDDEN: "FORBIDDEN",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",

  // 404
  NOT_FOUND: "NOT_FOUND",

  // 413
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",

  // 409
  CONFLICT: "CONFLICT",
  RESOURCE_BUSY: "RESOURCE_BUSY",

  // 429
  RATE_LIMITED: "RATE_LIMITED",

  // 500
  INTERNAL_ERROR: "INTERNAL_ERROR",

  // 503
  QBO_NOT_CONFIGURED: "QBO_NOT_CONFIGURED"
});

export class AppError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} code - Machine-readable error code from ErrorCode
   * @param {string} message - Human-readable error message
   * @param {Array} [errors] - Optional validation error details
   */
  constructor(statusCode, code, message, errors) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    if (errors) this.errors = errors;
  }
}

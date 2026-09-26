import axios from "axios";
import { normalizeArray } from "@easytestdata/core";

function toBase64(value) {
  return Buffer.from(value).toString("base64");
}

function parseQboError(error) {
  const response = error?.response?.data;
  const qboErrors = normalizeArray(response?.Fault?.Error);
  if (qboErrors.length > 0) {
    return qboErrors
      .map((item) => `${item.Message || "Unknown"}${item.Detail ? ` (${item.Detail})` : ""}`)
      .join("; ");
  }
  return error.message || "Unknown QBO API error.";
}

/**
 * EasyTestData is sandbox-only by design: it must never write synthetic data into a
 * production QuickBooks company. QboClient refuses any other API host.
 */
export const QBO_SANDBOX_BASE_URL = "https://sandbox-quickbooks.api.intuit.com";

export function assertSandboxBaseUrl(baseUrl) {
  const normalized = String(baseUrl ?? "").replace(/\/+$/, "");
  if (normalized !== QBO_SANDBOX_BASE_URL) {
    throw new Error(
      `EasyTestData only talks to QuickBooks Online sandbox companies. ` +
        `Refusing QBO API base URL "${baseUrl}"; expected ${QBO_SANDBOX_BASE_URL}.`
    );
  }
  return QBO_SANDBOX_BASE_URL;
}

/**
 * Thrown instead of sending a request once the client's `signal` has aborted. `cancelled` lets
 * callers tell it from a QBO error.
 */
export class QboRequestCancelledError extends Error {
  constructor() {
    super("QuickBooks request not sent: the operation was cancelled.");
    this.name = "QboRequestCancelledError";
    this.cancelled = true;
  }
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

const RATE_LIMIT = 450;
const RATE_WINDOW_MS = 61_000;
const QBO_HTTP_TIMEOUT_MS = 30_000;

/**
 * `cfg.signal` (optional) binds the client to one operation: once it aborts, the client starts no
 * new request (including retries and rate-limit waits), so no QBO call is made after a job is
 * cancelled, timed out or shut down however deep in a helper the call is. A request already sent
 * is left to finish: QBO may have applied it, and the batch helpers need its answer for the ledger.
 */
export class QboClient {
  constructor(cfg) {
    this.baseUrl = assertSandboxBaseUrl(cfg.qboBaseUrl ?? QBO_SANDBOX_BASE_URL);
    this.cfg = cfg;
    this.accessToken = cfg.qboAccessToken || "";
    this.refreshToken = cfg.qboRefreshToken || "";
    this.tokenUpdatedAt = this.accessToken ? Date.now() : 0;
    this._callTimestamps = [];
    this._inFlight = 0; // Requests sent but not finished, counted by the rate limiter
    this._refreshPromise = null; // The refresh in progress, shared by concurrent callers
    this.onRateLimitWait = null;
    this.onTokenRefresh = cfg.onTokenRefresh || null;
    this.onWarning = cfg.onWarning || null;
    this.signal = cfg.signal || null;
  }

  _throwIfCancelled() {
    if (this.signal?.aborted) throw new QboRequestCancelledError();
  }

  canRefresh() {
    const { qboClientId, qboClientSecret, qboRefreshToken } = this.cfg;
    return Boolean(qboClientId && qboClientSecret && qboRefreshToken);
  }

  async ensureAccessToken() {
    if (this.accessToken && !this.isTokenLikelyExpired()) {
      return this.accessToken;
    }
    if (this.canRefresh()) {
      // Deduplicate concurrent refresh calls
      if (!this._refreshPromise) {
        this._refreshPromise = this.refreshAccessToken().finally(() => {
          this._refreshPromise = null;
        });
      }
      await this._refreshPromise;
    } else if (!this.accessToken) {
      throw new Error("No access token and no refresh credentials configured.");
    }
    return this.accessToken;
  }

  isTokenLikelyExpired() {
    if (!this.tokenUpdatedAt) return false;
    const age = Date.now() - this.tokenUpdatedAt;
    return age > 55 * 60 * 1000;
  }

  async refreshAccessToken() {
    const { qboClientId, qboClientSecret, qboRefreshToken } = this.cfg;
    if (!qboClientId || !qboClientSecret || !qboRefreshToken) {
      throw new Error("Missing refresh credentials for QBO OAuth token refresh.");
    }

    let tokenResponse;
    try {
      tokenResponse = await axios.post(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: this.refreshToken || qboRefreshToken
        }).toString(),
        {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${toBase64(`${qboClientId}:${qboClientSecret}`)}`
          },
          timeout: QBO_HTTP_TIMEOUT_MS
        }
      );
    } catch (err) {
      const detail = err?.response?.data || err.message;
      throw new Error(`Token refresh failed: ${JSON.stringify(detail)}`, { cause: err });
    }

    this.accessToken = tokenResponse.data.access_token;
    const newRefreshToken = tokenResponse.data.refresh_token;
    if (newRefreshToken && newRefreshToken !== this.refreshToken) {
      this.refreshToken = newRefreshToken;
      this.cfg.qboRefreshToken = newRefreshToken;
      if (this.onTokenRefresh) {
        try {
          await this.onTokenRefresh({
            accessToken: this.accessToken,
            refreshToken: newRefreshToken
          });
        } catch (cbErr) {
          if (this.onWarning) {
            this.onWarning(
              "[QboClient] onTokenRefresh callback failed — refresh token may not be persisted.",
              cbErr
            );
          }
        }
      }
    }
    this.tokenUpdatedAt = Date.now();
  }

  async _throttle() {
    const now = Date.now();
    this._callTimestamps = this._callTimestamps.filter((t) => now - t < RATE_WINDOW_MS);
    // Account for in-flight requests that haven't completed yet
    const effectiveCount = this._callTimestamps.length + this._inFlight;
    if (effectiveCount >= RATE_LIMIT) {
      const oldest = this._callTimestamps[0];
      const waitMs = oldest ? RATE_WINDOW_MS - (now - oldest) : 1000;
      if (waitMs > 0) {
        const waitSec = Math.ceil(waitMs / 1000);
        if (this.onRateLimitWait) {
          this.onRateLimitWait(`Rate limit reached (${RATE_LIMIT}/min). Waiting ${waitSec}s...`);
        }
        await wait(waitMs, this.signal);
        this._callTimestamps = this._callTimestamps.filter((t) => Date.now() - t < RATE_WINDOW_MS);
      }
    }
    this._callTimestamps.push(Date.now());
    this._inFlight++;
  }

  async request(method, urlPath, options = {}) {
    const {
      params = {},
      data = null,
      headers = {},
      allowRefresh = true,
      _retryCount = 0
    } = options;
    this._throwIfCancelled();
    await this._throttle();
    try {
      this._throwIfCancelled(); // the rate-limit wait may have outlasted the operation
      const token = await this.ensureAccessToken();
      const url = `${assertSandboxBaseUrl(this.baseUrl)}/v3/company/${this.cfg.qboRealmId}${urlPath}`;

      const mergedParams = {
        minorversion: this.cfg.qboMinorVersion || "65",
        ...params
      };

      try {
        const response = await axios.request({
          method,
          url,
          params: mergedParams,
          paramsSerializer: (p) =>
            Object.entries(p)
              .filter(([, v]) => v !== undefined && v !== null)
              .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
              .join("&"),
          data,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            ...headers
          },
          timeout: QBO_HTTP_TIMEOUT_MS
        });
        return response.data;
      } catch (error) {
        const status = error?.response?.status;

        if ((status === 401 || status === 403) && allowRefresh && this.canRefresh()) {
          await this.refreshAccessToken();
          return this.request(method, urlPath, { params, data, headers, allowRefresh: false });
        }

        // A 429 means QBO refused the request unprocessed, so anything may be resent. A 500/503
        // may arrive after QBO committed the write, so only reads are retried then: replaying a
        // create or batch would duplicate records the load ledger never sees.
        const retryable =
          status === 429 || ((status === 503 || status === 500) && method.toUpperCase() === "GET");
        if (retryable && _retryCount < 3) {
          const delayMs = Math.min(1000 * Math.pow(2, _retryCount), 8000);
          await wait(delayMs, this.signal);
          return this.request(method, urlPath, {
            params,
            data,
            headers,
            allowRefresh,
            _retryCount: _retryCount + 1
          });
        }

        throw new Error(parseQboError(error), { cause: error });
      }
    } finally {
      this._inFlight = Math.max(0, this._inFlight - 1);
    }
  }

  async getCompanyInfo() {
    return this.request("GET", `/companyinfo/${this.cfg.qboRealmId}`);
  }

  async query(sql) {
    return this.request("GET", "/query", {
      params: { query: sql }
    });
  }

  async create(entity, payload) {
    return this.request("POST", `/${entity}`, {
      headers: { "Content-Type": "application/json" },
      data: payload
    });
  }

  async update(entity, payload) {
    return this.request("POST", `/${entity}`, {
      headers: { "Content-Type": "application/json" },
      data: payload
    });
  }

  async batch(batchItemRequest) {
    return this.request("POST", "/batch", {
      headers: { "Content-Type": "application/json" },
      data: { BatchItemRequest: batchItemRequest }
    });
  }

  async delete(entity, id, syncToken) {
    return this.request("POST", `/${entity}`, {
      params: { operation: "delete" },
      headers: { "Content-Type": "application/json" },
      data: {
        Id: id,
        SyncToken: syncToken,
        sparse: true
      }
    });
  }
}

export function getQueryItems(response, entityName) {
  const queryResult = response?.QueryResponse?.[entityName];
  if (!queryResult) return [];
  return Array.isArray(queryResult) ? queryResult : [queryResult];
}

// Shared API client — consumed by @easytestdata/web (Cloud and local mode).
// setErrorHandler() replaces the default handler (console.error for server errors).

import type { AuthResponse } from "./types";

export type { AuthResponse };

// Inline entity types for API return signatures — canonical types live in @easytestdata/ui.
// We duplicate the shapes here to avoid a circular dependency on the ui package.
interface QboConnection {
  id: string;
  realm_id: string;
  company_name: string;
  base_url: string;
  connected_at: string;
  last_used_at: string | null;
  tokenHealth?: "ok" | "warning" | "expired";
  /** The sandbox holds data from an earlier load (completed, or failed with records left). */
  has_prior_load?: boolean;
}
interface ConnectionHealth {
  connectionId: string;
  status: "healthy" | "warning" | "expired";
  daysSinceActivity: number;
  warnings: string[];
}
interface JobResultSummary {
  metrics?: Record<string, number | undefined> | null;
  counts?: Record<string, number> | null;
  artifact?: { filename: string; path: string; format: string } | null;
  deletedByEntity?: Record<string, number> | null;
  deletedTotal?: number | null;
  masterData?: Record<string, number> | null;
  failureCount?: number | null;
  totalDeleted?: number | null;
  /** Rollback: master data made inactive (QBO cannot delete it). */
  totalInactivated?: number | null;
  /** Rollback: why master data was kept (a later load may use it). */
  note?: string | null;
}
interface Job {
  id: string;
  type: string;
  status: string;
  connection_id?: string | null;
  config: Record<string, unknown>;
  progress: unknown;
  result: unknown;
  error: string | null;
  entity_count: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  result_summary?: JobResultSummary | null;
  /** A load whose rollback completed (its status stays failed; its records are gone). */
  rolled_back?: boolean;
}
interface IndustryTemplate {
  id: string;
  name: string;
  description: string;
}
interface ScenarioPresetDetail {
  id: string;
  name: string;
  description: string;
  request: Record<string, unknown>;
  ratioOverrides: Record<string, number>;
  /** Suggested period length (the quick demo is 3 months). */
  months?: number;
}
/** What a load would create; `metrics` are the plan's per-type counts. */
export interface LoadEstimate {
  estimatedEntities: number;
  metrics?: Record<string, number> | null;
  limit: number;
}

const BASE = "/api/v1";

/**
 * Sent on every request. Local mode (no sign-in) refuses state-changing requests without it: a
 * page on another site cannot add a custom header without a CORS preflight, which it never gets.
 */
export const CLIENT_HEADERS: Readonly<Record<string, string>> = { "X-EasyTestData": "1" };

// ── Token management ────────────────────────────────────────────────────────

let accessToken: string | null = localStorage.getItem("accessToken");
let refreshToken: string | null = localStorage.getItem("refreshToken");

/**
 * Fired on window whenever new tokens are stored (e.g. after a refresh or a team switch) or the
 * tokens are cleared (sign-out, or a refresh the server rejected), after the change. Also fired
 * when another tab stored or cleared them, with `detail: { fromOtherTab: true }`.
 */
export const TOKENS_CHANGED_EVENT = "easytestdata:tokens";

function announceTokensChanged(detail?: { fromOtherTab: true }) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(TOKENS_CHANGED_EVENT, { detail }));
  } catch {
    // Non-browser environments
  }
}

// Another tab signed in, switched teams, refreshed or signed out: take its tokens, so this tab
// never keeps acting as the old account or team. Browsers fire "storage" only in the other tabs,
// and this handler only reads storage, so it cannot loop.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key !== null && event.key !== "accessToken" && event.key !== "refreshToken") return;
    const previous = accessToken;
    accessToken = readStoredToken("accessToken");
    refreshToken = readStoredToken("refreshToken");
    if (accessToken !== previous) announceTokensChanged({ fromOtherTab: true });
  });
}

export function storeTokens(data: { accessToken?: string; refreshToken?: string }) {
  if (data.accessToken) {
    accessToken = data.accessToken;
    localStorage.setItem("accessToken", data.accessToken);
  }
  if (data.refreshToken) {
    refreshToken = data.refreshToken;
    localStorage.setItem("refreshToken", data.refreshToken);
  }
  if (data.accessToken) announceTokensChanged();
}

/** Clears the tokens and announces it, so the auth state signs out too (AuthContext). */
export function clearTokens() {
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
  announceTokensChanged();
}

export function getAccessToken() {
  return accessToken;
}

/**
 * Who an access token acts as (`sub` + `teamId`, read from the payload without verification).
 * Used to notice that a token adopted from another tab, or a refresh that landed in another
 * team, would run a request as someone else. Null for anything that is not a JWT.
 */
export function tokenIdentity(token: string | null): { sub: string; teamId: string } | null {
  const payloadPart = token?.split(".")[1];
  if (!payloadPart) return null;
  try {
    const payload = JSON.parse(atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/"))) as Record<
      string,
      unknown
    >;
    return { sub: String(payload.sub ?? ""), teamId: String(payload.teamId ?? "") };
  } catch {
    return null;
  }
}

function sameIdentity(a: ReturnType<typeof tokenIdentity>, b: ReturnType<typeof tokenIdentity>) {
  return Boolean(a && b && a.sub === b.sub && a.teamId === b.teamId);
}

export function isAuthenticated() {
  return !!accessToken;
}

type RefreshAccessTokenResult =
  { refreshed: true } | { refreshed: false; error?: ApiError; clearableFailure?: boolean };

function shouldClearTokensAfterRefreshFailure(status: number) {
  return status === 400 || status === 401 || status === 403 || status === 404;
}

// The server treats a rotated refresh token presented again as theft and signs the user out
// everywhere, so concurrent 401s share one refresh, and every refresh uses the newest token
// (another tab may already have rotated it in localStorage).
let refreshInFlight: Promise<RefreshAccessTokenResult> | null = null;

function refreshAccessToken(): Promise<RefreshAccessTokenResult> {
  if (!refreshInFlight) {
    refreshInFlight = doRefreshAccessToken().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

function readStoredToken(key: "accessToken" | "refreshToken"): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // Storage unavailable
  }
}

async function doRefreshAccessToken(): Promise<RefreshAccessTokenResult> {
  refreshToken = readStoredToken("refreshToken") ?? refreshToken;
  if (!refreshToken) return { refreshed: false };
  const usedRefreshToken = refreshToken;
  try {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { ...CLIENT_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: usedRefreshToken })
    });
    if (!res.ok) {
      const errorBody = await res.json().catch(() => ({}));
      const clearableFailure = shouldClearTokensAfterRefreshFailure(res.status);
      if (clearableFailure) {
        // Another tab may have rotated the refresh token while this request was in flight (the
        // server then rejects ours). Use the tokens it stored instead of signing out; clear only
        // when storage still holds the token that was rejected.
        const storedRefresh = readStoredToken("refreshToken");
        const storedAccess = readStoredToken("accessToken");
        if (storedRefresh && storedRefresh !== usedRefreshToken && storedAccess) {
          // Adopt them the same way a refresh would: AuthContext listens for
          // TOKENS_CHANGED_EVENT to follow a user/team change made in the other tab.
          storeTokens({ accessToken: storedAccess, refreshToken: storedRefresh });
          return { refreshed: true };
        }
        clearTokens();
      }
      return {
        refreshed: false,
        clearableFailure,
        error: new ApiError(
          errorBody.error || errorBody.message || `Token refresh failed (${res.status})`,
          res.status,
          errorBody
        )
      };
    }
    const data = await res.json();
    storeTokens(data);
    return { refreshed: true };
  } catch {
    return {
      refreshed: false,
      clearableFailure: false,
      error: new ApiError("Authentication service unavailable", 503, {})
    };
  }
}

// ── Error handling ──────────────────────────────────────────────────────────

export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

type ErrorHandler = (
  error: ApiError,
  method: string,
  path: string,
  status: number,
  body: Record<string, unknown>
) => void;

let errorHandler: ErrorHandler = (error, method, path) => {
  if (error.status >= 500) {
    console.error(`API error ${method} ${path}:`, error);
  }
};

export function setErrorHandler(handler: ErrorHandler) {
  errorHandler = handler;
}

// ── Core request ────────────────────────────────────────────────────────────

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${BASE}${path}`;

  const headers: Record<string, string> = { ...CLIENT_HEADERS };
  const requestToken = accessToken;
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const opts: RequestInit = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let res = await fetch(url, opts);

  if (res.status === 401 && refreshToken) {
    const refreshResult = await refreshAccessToken();
    if (refreshResult.refreshed) {
      // A refresh can land in another user/team (another tab switched teams or signed in as
      // someone else). Reads are harmless to retry there; a write started under the old
      // identity must not be replayed silently under the new one.
      const before = tokenIdentity(requestToken);
      const after = tokenIdentity(accessToken);
      if (method.toUpperCase() !== "GET" && before && after && !sameIdentity(before, after)) {
        const changed = new ApiError(
          "Your session changed in another tab (different team or account). Please try again.",
          409,
          { code: "SESSION_CHANGED", error: "Session changed" }
        );
        errorHandler(changed, method, path, changed.status, changed.body);
        throw changed;
      }
      const retryHeaders = { ...headers, Authorization: `Bearer ${accessToken}` };
      const retryOpts: RequestInit = { method, headers: retryHeaders };
      if (body !== undefined) retryOpts.body = JSON.stringify(body);
      res = await fetch(url, retryOpts);
    } else if (refreshResult.error && !refreshResult.clearableFailure) {
      errorHandler(
        refreshResult.error,
        "POST",
        "/auth/refresh",
        refreshResult.error.status,
        refreshResult.error.body
      );
      throw refreshResult.error;
    }
  }

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    const apiError = new ApiError(
      errorBody.error || errorBody.message || `API ${method} ${path} failed (${res.status})`,
      res.status,
      errorBody
    );

    errorHandler(apiError, method, path, res.status, errorBody);
    throw apiError;
  }

  if (res.status === 204) return null as T;
  return res.json();
}

// ── Auth ────────────────────────────────────────────────────────────────────

export function logout() {
  clearTokens();
}

export async function exchangeOAuthCode(code: string) {
  const data = await request<AuthResponse>("POST", "/auth/oauth/exchange", { code });
  storeTokens(data);
  return data;
}

export async function getProfile() {
  return request<{
    id: string;
    email: string;
    display_name: string;
    avatar_url: string | null;
    is_admin?: boolean;
    /** The team this session acts in (local mode has no token to read it from). */
    team_id?: string;
  }>("GET", "/auth/profile");
}

// ── Connections ─────────────────────────────────────────────────────────────

export const getConnections = () => request<QboConnection[]>("GET", "/connections");
export const authorizeConnection = (mode?: "popup" | "redirect") =>
  request<{ url: string }>("GET", `/connections/authorize${mode ? `?mode=${mode}` : ""}`);
export const deleteConnection = (id: string) => request("DELETE", `/connections/${id}`);
export const testConnection = (id: string) =>
  request<{ ok: boolean; companyName?: string; error?: string }>("POST", `/connections/${id}/test`);
export const checkConnectionHealth = (id: string) =>
  request<ConnectionHealth>("GET", `/connections/${id}/health`);
export const purgeConnection = (id: string, mode?: "generated" | "all", tag?: string) =>
  request<Job>("POST", `/connections/${id}/purge`, {
    mode: mode || "generated",
    tag: tag || "EZTD"
  });

// ── Jobs ────────────────────────────────────────────────────────────────────

/** A job carries its whole configuration; the server validates and snapshots it. */
export interface CreateJobBody {
  type: "generate" | "export" | "load" | "purge";
  /** Required for load and purge; generate/export build a file offline. */
  connectionId?: string;
  templateId: string;
  config: Record<string, unknown>;
}
export type EstimateJobBody = Pick<CreateJobBody, "templateId" | "config">;

export const getJobs = () => request<Job[]>("GET", "/jobs");

/** This month's usage against the deployment's limits (-1 = unlimited, as in local mode). */
export interface JobUsage {
  deployment: "cloud" | "local";
  limits: { loadsPerMonth: number; entitiesPerJob: number; connections: number };
  usage: { loads: number; entities: number };
}
export const getJobUsage = () => request<JobUsage>("GET", "/jobs/usage");
export const getJob = (id: string) => request<Job>("GET", `/jobs/${id}`);
export const createJob = (body: CreateJobBody) => request<Job>("POST", "/jobs", body);
/** What a job for this config would create, and the per-job record limit (-1 = none). */
export const estimateJob = (body: EstimateJobBody) =>
  request<LoadEstimate>("POST", "/jobs/estimate", body);
export const cancelJob = (id: string) => request<Job>("POST", `/jobs/${id}/cancel`);
export const rollbackJob = (id: string) => request<Job>("POST", `/jobs/${id}/rollback`);
export const getJobData = (id: string) =>
  request<Record<string, unknown>>("GET", `/jobs/${id}/data`);

export async function authenticatedDownload(path: string, fallbackFilename: string) {
  const url = `${BASE}${path}`;
  const headers: Record<string, string> = { ...CLIENT_HEADERS };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  let res = await fetch(url, { method: "GET", headers });
  if (res.status === 401 && refreshToken) {
    const refreshResult = await refreshAccessToken();
    if (refreshResult.refreshed) {
      const retryHeaders = { ...headers, Authorization: `Bearer ${accessToken}` };
      res = await fetch(url, { method: "GET", headers: retryHeaders });
    } else if (refreshResult.error && !refreshResult.clearableFailure) {
      throw refreshResult.error;
    }
  }

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(errorBody.error || errorBody.message || `Download failed (${res.status})`);
  }

  const blob = await res.blob();
  const header = res.headers.get("content-disposition") || "";
  const match = header.match(/filename="?([^";]+)"?/i);
  const fileName = match?.[1] ?? fallbackFilename;

  const blobUrl = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(blobUrl);
}

export type JobDownloadFormat = "json" | "csv";

export function downloadJob(id: string, format: JobDownloadFormat = "json") {
  return authenticatedDownload(
    `/jobs/${id}/download?format=${format}`,
    // CSV downloads are a zip with one CSV per record type.
    format === "csv" ? `easytestdata-${id}-csv.zip` : `easytestdata-${id}.json`
  );
}

// ── Templates ───────────────────────────────────────────────────────────────

export const getIndustryTemplates = () =>
  request<IndustryTemplate[]>("GET", "/templates/industries");
export const getIndustryTemplate = (id: string) =>
  request<IndustryTemplate>("GET", `/templates/industries/${id}`);
export const getScenarioPresets = () => request<unknown[]>("GET", "/templates/presets");
export const getScenarioPreset = (id: string) =>
  request<ScenarioPresetDetail>("GET", `/templates/presets/${id}`);

import { captureException, addBreadcrumb } from "../contexts/SentryContext";
import {
  CLIENT_HEADERS,
  setErrorHandler,
  storeTokens,
  authenticatedDownload,
  request
} from "@easytestdata/shared/api-client";
export { TOKENS_CHANGED_EVENT } from "@easytestdata/shared/api-client";
import type { PublicConfigBase } from "@easytestdata/shared/types";
import type { AuthResponse } from "@easytestdata/shared/api-client";

// Re-export everything from shared api-client
export {
  clearTokens,
  getAccessToken,
  isAuthenticated,
  ApiError,
  request,
  logout,
  exchangeOAuthCode,
  getProfile,
  getConnections,
  authorizeConnection,
  deleteConnection,
  testConnection,
  checkConnectionHealth,
  purgeConnection,
  getJobs,
  getJob,
  createJob,
  estimateJob,
  cancelJob,
  rollbackJob,
  getJobData,
  downloadJob,
  getIndustryTemplates,
  getIndustryTemplate,
  getScenarioPresets,
  getScenarioPreset
} from "@easytestdata/shared/api-client";

// Re-export UI types
export type {
  QboConnection,
  ConnectionHealth,
  JobMetrics,
  JobResultSummary,
  Job,
  IndustryTemplate,
  ScenarioPresetDetail
} from "@easytestdata/ui";

export type { AuthResponse } from "@easytestdata/shared/api-client";

// ── Sentry error handler ────────────────────────────────────────────────────

setErrorHandler((apiError, method, path, status, errorBody) => {
  if (status >= 500) {
    captureException(apiError, {
      tags: { apiMethod: method, apiPath: path },
      extra: { status, responseBody: errorBody }
    });
  } else {
    addBreadcrumb({
      category: "api",
      message: `${method} ${path} → ${status}`,
      level: "warning",
      data: { status, error: apiError.message }
    });
  }
});

// ── Public Config (web-specific, extends base) ──────────────────────────────

export interface PublicConfig extends PublicConfigBase {
  sentryDsn: string | null;
  enabledOAuthProviders: string[];
}

const BASE = "/api/v1";

export async function getPublicConfig(): Promise<PublicConfig> {
  const res = await fetch(`${BASE}/config/public`, { headers: CLIENT_HEADERS });
  if (!res.ok) throw new Error("Failed to load public config");
  return res.json();
}

// ── Download (web-specific) ─────────────────────────────────────────────────

export function adminDownload(path: string, fallbackFilename: string) {
  return authenticatedDownload(path, fallbackFilename);
}

// ── Teams ───────────────────────────────────────────────────────────────────

export interface Team {
  id: string;
  name: string;
  role: string;
}

export interface TeamMember {
  user_id: string;
  email: string;
  display_name: string;
  role: string;
  created_at: string;
}

export interface TeamInvite {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  created_at: string;
  /** A pending invite to this address was re-issued with a new link. */
  alreadyPending?: boolean;
  /** The link the inviter shares. */
  inviteUrl: string;
}

export type TeamSessionResponse = AuthResponse & { role?: string };

export const getTeams = () => request<Team[]>("GET", "/teams");
export const getTeamMembers = (teamId: string) =>
  request<TeamMember[]>("GET", `/teams/${teamId}/members`);
export const getTeamInvites = (teamId: string) =>
  request<TeamInvite[]>("GET", `/teams/${teamId}/invites`);
export const inviteTeamMember = (teamId: string, email: string, role?: string) =>
  request<TeamInvite>("POST", `/teams/${teamId}/invites`, { email, role: role || "member" });
/** Accepts an invite; the response carries fresh tokens for the joined team, stored here. */
export async function acceptTeamInvite(token: string) {
  // In the body, not the URL: request paths end up in logs.
  const data = await request<TeamSessionResponse & { accepted: boolean }>(
    "POST",
    "/teams/invites/accept",
    { token }
  );
  storeTokens(data);
  return data;
}

/** Makes `teamId` the active team and stores tokens issued for it. */
export async function switchTeam(teamId: string) {
  const data = await request<TeamSessionResponse>("POST", "/auth/switch-team", { teamId });
  storeTokens(data);
  return data;
}

export const removeTeamMember = (teamId: string, userId: string) =>
  request<{ removed: boolean }>("DELETE", `/teams/${teamId}/members/${userId}`);
export const revokeTeamInvite = (teamId: string, inviteId: string) =>
  request<{ deleted: boolean }>("DELETE", `/teams/${teamId}/invites/${inviteId}`);

import { request } from "./client";

// ── Dashboard ─────────────────────────────────────────────────────────────

export interface DashboardKPIs {
  totalUsers: number;
  newUsers7d: number;
  totalTeams: number;
  activeJobs: number;
  jobsToday: number;
  failedJobs24h: number;
  totalJobs: number;
  totalEntities: number;
  activeConnections: number;
  system: {
    database: string;
    uptimeSeconds: number;
    nodeVersion: string;
    memoryMb: { rss: number; heapUsed: number };
    jobsByStatus: Record<string, number>;
  };
}

export interface TrendPoint {
  date: string;
  count: number;
  type?: string;
}

export interface ConversionFunnel {
  signups: number;
  connected: number;
  first_job: number;
}

export const getAdminDashboard = () => request<DashboardKPIs>("GET", "/admin/dashboard");
export const getAdminTrends = (metric: string, period = "daily", days = 30) =>
  request<TrendPoint[]>(
    "GET",
    `/admin/dashboard/trends?metric=${metric}&period=${period}&days=${days}`
  );
export const getConversionFunnel = () =>
  request<ConversionFunnel>("GET", "/admin/dashboard/conversion-funnel");

// ── Users ─────────────────────────────────────────────────────────────────

export interface AdminUser {
  id: string;
  email: string;
  display_name: string;
  oauth_provider: string | null;
  avatar_url: string | null;
  is_admin: boolean;
  suspended_at: string | null;
  suspended_reason: string | null;
  created_at: string;
  team_count: number;
  job_count: number;
}

export interface AdminUserDetail {
  user: AdminUser;
  teams: { id: string; name: string; role: string }[];
  recentJobs: {
    id: string;
    type: string;
    status: string;
    entity_count: number | null;
    created_at: string;
  }[];
}

export interface PaginatedResponse<_T> {
  total: number;
  page: number;
  limit: number;
  [key: string]: unknown;
}

export const getAdminUsers = (params: Record<string, string> = {}) => {
  const qs = new URLSearchParams(params).toString();
  return request<{ users: AdminUser[]; total: number; page: number; limit: number }>(
    "GET",
    `/admin/users?${qs}`
  );
};
export const getAdminUser = (id: string) => request<AdminUserDetail>("GET", `/admin/users/${id}`);
export const suspendUser = (id: string, reason?: string) =>
  request("POST", `/admin/users/${id}/suspend`, { reason });
export const unsuspendUser = (id: string) => request("POST", `/admin/users/${id}/unsuspend`);
export const revokeUserSessions = (id: string) =>
  request("POST", `/admin/users/${id}/revoke-sessions`);

// ── Jobs ──────────────────────────────────────────────────────────────────

export interface AdminJob {
  id: string;
  type: string;
  status: string;
  entity_count: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  team_id: string;
  team_name: string;
}

export const getAdminJobs = (params: Record<string, string> = {}) => {
  const qs = new URLSearchParams(params).toString();
  return request<{ jobs: AdminJob[]; total: number; page: number; limit: number }>(
    "GET",
    `/admin/jobs?${qs}`
  );
};
export const getAdminJob = (id: string) =>
  request<AdminJob & { config: unknown; progress: unknown; result: unknown }>(
    "GET",
    `/admin/jobs/${id}`
  );
export const cancelAdminJob = (id: string) => request("POST", `/admin/jobs/${id}/cancel`);
export const retryAdminJob = (id: string) => request("POST", `/admin/jobs/${id}/retry`);
/** 202 `status: "running"` when the job's work is being stopped; 200 `status: "failed"` when done. */
export const forceFailJob = (id: string) =>
  request<{ success: boolean; status: "running" | "failed"; message: string }>(
    "POST",
    `/admin/jobs/${id}/force-fail`
  );
export const getJobStats = () =>
  request<{
    statusBreakdown: { status: string; count: number }[];
    avgDuration: { type: string; avg_seconds: number }[];
    failureRate: { date: string; failed: number; total: number }[];
  }>("GET", "/admin/jobs/stats");

// ── Connections ───────────────────────────────────────────────────────────

export interface AdminConnection {
  id: string;
  company_name: string;
  realm_id: string;
  connected_at: string;
  last_used_at: string | null;
  team_id: string;
  team_name: string;
  days_idle: number;
  job_count: number;
}

export const getAdminConnections = (params: Record<string, string> = {}) => {
  const qs = new URLSearchParams(params).toString();
  return request<{ connections: AdminConnection[]; total: number; page: number; limit: number }>(
    "GET",
    `/admin/connections?${qs}`
  );
};
export const testAdminConnection = (id: string) =>
  request<{ ok: boolean; companyName?: string }>("POST", `/admin/connections/${id}/test`);
export const deleteAdminConnection = (id: string) => request("DELETE", `/admin/connections/${id}`);

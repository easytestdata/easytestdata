// Shared React Query hooks — consumed by @easytestdata/web (Cloud and local mode).

import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys, ACTIVE_JOB_STATUSES } from "./query-keys.js";
import * as api from "./api-client";

// ── Connections ─────────────────────────────────────────────────────────────

export function useConnections() {
  return useQuery({ queryKey: queryKeys.connections.all, queryFn: api.getConnections });
}

export function useDeleteConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: (_data: unknown, id: string) => {
      qc.removeQueries({ queryKey: queryKeys.connections.health(id) });
      return qc.invalidateQueries({ queryKey: queryKeys.connections.all });
    }
  });
}

export function useTestConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.testConnection(id),
    // A test refreshes the token and last use, so the list's token status and the health check
    // (both under ["connections"]) are stale afterwards.
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.connections.all })
  });
}

export function useConnectionHealth(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.connections.health(id!),
    queryFn: () => api.checkConnectionHealth(id!),
    enabled: !!id,
    staleTime: 60 * 1000,
    retry: false
  });
}

/**
 * The ids of the given connections whose detailed health check says expired (which also catches
 * stored tokens that can no longer be read). Shares useConnectionHealth's cache entries.
 */
export function useExpiredConnectionIds(ids: string[]): Set<string> {
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: queryKeys.connections.health(id),
      queryFn: () => api.checkConnectionHealth(id),
      staleTime: 60 * 1000,
      retry: false
    }))
  });
  return new Set(ids.filter((_, i) => results[i]?.data?.status === "expired"));
}

export function usePurgeConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; mode?: "generated" | "all"; tag?: string }) =>
      api.purgeConnection(args.id, args.mode, args.tag),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.jobs.all })
  });
}

// ── Jobs ────────────────────────────────────────────────────────────────────

// Job progress arrives by polling: active jobs are re-read every 2 seconds.
const JOB_POLL_INTERVAL_MS = 2000;

export function useJobUsage() {
  return useQuery({ queryKey: queryKeys.usage, queryFn: api.getJobUsage });
}

export function useJobs() {
  return useQuery({
    queryKey: queryKeys.jobs.all,
    queryFn: api.getJobs,
    refetchInterval: (query) => {
      const jobs = query.state.data;
      if (Array.isArray(jobs) && jobs.some((j) => ACTIVE_JOB_STATUSES.includes(j.status))) {
        return JOB_POLL_INTERVAL_MS;
      }
      return false;
    }
  });
}

export function useJob(id: string, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.jobs.detail(id),
    queryFn: () => api.getJob(id),
    enabled: opts?.enabled ?? true,
    refetchInterval: (query) => {
      const job = query.state.data;
      if (job && ACTIVE_JOB_STATUSES.includes(job.status)) {
        return JOB_POLL_INTERVAL_MS;
      }
      return false;
    }
  });
}

export function useJobData(id: string, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.jobs.data(id),
    queryFn: () => api.getJobData(id),
    enabled: opts?.enabled ?? true,
    staleTime: Infinity
  });
}

export function useCreateJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: api.CreateJobBody) => api.createJob(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.jobs.all })
  });
}

export function useEstimateJob() {
  return useMutation({ mutationFn: (body: api.EstimateJobBody) => api.estimateJob(body) });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.cancelJob(jobId),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.jobs.all })
  });
}

export function useRollbackJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.rollbackJob(jobId),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.jobs.all })
  });
}

// ── Templates ───────────────────────────────────────────────────────────────

export function useIndustryTemplates() {
  return useQuery({
    queryKey: queryKeys.templates.industries,
    queryFn: api.getIndustryTemplates,
    staleTime: 5 * 60 * 1000
  });
}

export function useScenarioPresets() {
  return useQuery({
    queryKey: queryKeys.templates.presets,
    queryFn: api.getScenarioPresets,
    staleTime: 5 * 60 * 1000
  });
}

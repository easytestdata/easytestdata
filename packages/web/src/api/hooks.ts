// Re-export all shared hooks
export {
  useConnections,
  useDeleteConnection,
  useTestConnection,
  useConnectionHealth,
  useExpiredConnectionIds,
  usePurgeConnection,
  useJobs,
  useJobUsage,
  useJob,
  useJobData,
  useCreateJob,
  useEstimateJob,
  useCancelJob,
  useRollbackJob,
  useIndustryTemplates,
  useScenarioPresets
} from "@easytestdata/shared/api-hooks";

// ── Web-only hooks ──────────────────────────────────────────────────────────

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@easytestdata/shared/query-keys";
import * as api from "./client";

export function useTeams() {
  return useQuery({ queryKey: queryKeys.teams.all, queryFn: api.getTeams });
}

export function useTeamMembers(teamId: string) {
  return useQuery({
    queryKey: queryKeys.teams.members(teamId),
    queryFn: () => api.getTeamMembers(teamId),
    enabled: !!teamId
  });
}

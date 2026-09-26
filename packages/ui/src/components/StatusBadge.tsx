import { Badge } from "./ui/badge";

const statusConfig: Record<
  string,
  { label: string; variant: "success" | "warning" | "destructive" | "secondary" | "info" }
> = {
  completed: { label: "Completed", variant: "success" },
  completed_with_errors: { label: "Completed with errors", variant: "warning" },
  running: { label: "Running", variant: "info" },
  cancelling: { label: "Cancelling", variant: "warning" },
  pending: { label: "Pending", variant: "secondary" },
  failed: { label: "Failed", variant: "destructive" },
  failed_with_orphans: { label: "Partly loaded", variant: "destructive" },
  rolled_back: { label: "Rolled back", variant: "warning" },
  cancelled: { label: "Cancelled", variant: "secondary" }
};

/**
 * A job's status as shown: a failed load whose rollback completed reads "Rolled back", and a job
 * that finished while QuickBooks refused some records reads "Completed with errors".
 */
export function displayStatus(job: {
  status: string;
  rolled_back?: boolean;
  result_summary?: { failureCount?: number | null } | null;
  result?: unknown;
}): string {
  if (job.rolled_back && job.status === "failed") return "rolled_back";
  if (job.status === "completed" && failureCount(job) > 0) return "completed_with_errors";
  return job.status;
}

/** Failures of a finished job, from the list's result_summary or a detail response's full result. */
function failureCount(job: {
  result_summary?: { failureCount?: number | null } | null;
  result?: unknown;
}): number {
  const result =
    job.result && typeof job.result === "object" ? (job.result as Record<string, unknown>) : null;
  return (
    job.result_summary?.failureCount ??
    (typeof result?.failureCount === "number" ? result.failureCount : null) ??
    (Array.isArray(result?.failures) ? result.failures.length : 0)
  );
}

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = statusConfig[status] ?? {
    label: status,
    variant: "secondary" as const
  };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}

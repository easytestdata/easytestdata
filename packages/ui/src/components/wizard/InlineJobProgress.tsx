import { useState, useEffect, useRef } from "react";
import { Progress } from "../ui/progress";
import { Button } from "../ui/button";
import { StatusBadge } from "../StatusBadge";
import { cn } from "../../lib/utils";
import { X, AlertCircle, Loader2, RotateCcw } from "lucide-react";
import { SuccessFlowSvg } from "../svg/SuccessFlowSvg";
import { JobDownloadButtons } from "../job-detail/JobDownloadButtons";
import { SandboxNextSteps } from "../job-detail/SandboxNextSteps";
import { readJobProgress, useJobProgressLog } from "../job-detail/useJobProgressLog";
import type { Job } from "../../types";
import { toast } from "sonner";

interface InlineJobProgressProps {
  job: Job;
  onJobUpdate?: () => void;
  connectionName?: string;
  onLoadMore?: () => void;
  onCancelJob: (jobId: string) => Promise<void>;
  /** Roll back a load that stopped with records left in QuickBooks (failed_with_orphans). */
  onRollback?: (jobId: string) => Promise<void>;
  /** Open the finished job's details. */
  onViewDetails?: (job: Job) => void;
}

export function InlineJobProgress({
  job,
  onJobUpdate,
  connectionName,
  onLoadMore,
  onCancelJob,
  onRollback,
  onViewDetails
}: InlineJobProgressProps) {
  const [step, setStep] = useState(0);
  const [totalSteps, setTotalSteps] = useState(0);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState(job.status);
  const [error, setError] = useState<string | null>(job.error || null);
  const log = useJobProgressLog(job, onJobUpdate);
  const [cancelling, setCancelling] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setStatus(job.status);
    setError(job.error || null);
    const progress = readJobProgress(job);
    setStep(progress.step);
    setTotalSteps(progress.totalSteps);
    setMessage(progress.message);
  }, [job]);

  useEffect(() => {
    const container = logContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [log]);

  const progressPct = totalSteps > 0 ? Math.round((step / totalSteps) * 100) : 0;
  const isActive = status === "running" || status === "pending";
  const isCompleted = status === "completed";
  const isFailed = status === "failed" || status === "failed_with_orphans";
  // Every other terminal state lets the card close; completed has its own view above.
  const isFinished = isFailed || status === "cancelled";

  async function handleCancel() {
    setCancelling(true);
    try {
      await onCancelJob(job.id);
      setStatus("cancelling");
      setMessage("Cancelling...");
      onJobUpdate?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not cancel the job");
    } finally {
      setCancelling(false);
    }
  }

  async function handleRollback() {
    if (!onRollback || rollingBack) return;
    setRollingBack(true);
    try {
      await onRollback(job.id);
    } finally {
      setRollingBack(false);
    }
  }

  const isDownloadJob = job.type === "generate" || job.type === "export";
  const isRollback = job.type === "rollback";
  const isPurge = job.type === "purge";
  const eraseAll = isPurge && (job.config as Record<string, unknown> | undefined)?.purgeMode === "all";
  const sandboxName = connectionName || "the QuickBooks sandbox";

  if (isCompleted && isDownloadJob) {
    return (
      <div className="rounded-xl border-2 border-emerald-200 bg-gradient-to-br from-emerald-50 to-teal-50 p-6 text-center">
        <div className="flex flex-col items-center gap-3">
          <SuccessFlowSvg className="w-48" />
          <div>
            <h3 className="text-lg font-semibold text-emerald-900">Your sample files are ready</h3>
            <p className="mt-1 text-sm text-emerald-700">
              {job.entity_count ? `${job.entity_count} records generated. ` : ""}
              Download it as JSON or CSV.
            </p>
          </div>
          <JobDownloadButtons
            job={job}
            size="default"
            className="mt-2 flex flex-wrap justify-center gap-2"
          />
          {onLoadMore && (
            <Button variant="ghost" size="sm" onClick={onLoadMore}>
              Make more sample files
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (isCompleted && isRollback) {
    return (
      <div className="rounded-xl border-2 border-emerald-200 bg-gradient-to-br from-emerald-50 to-teal-50 p-6 text-center">
        <div className="flex flex-col items-center gap-3">
          <h3 className="text-lg font-semibold text-emerald-900">Roll back finished</h3>
          <p className="text-sm text-emerald-700">{rollbackOutcome(job, sandboxName)}</p>
          {job.result_summary?.note && (
            <p className="text-sm text-emerald-700">{job.result_summary.note}</p>
          )}
          <div className="mt-2 flex gap-2">
            {onViewDetails && (
              <Button size="sm" variant="ghost" onClick={() => onViewDetails(job)}>
                View details
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => (onLoadMore ? onLoadMore() : window.location.reload())}
            >
              Close
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (isCompleted && isPurge) {
    // The job completes even when QuickBooks refused some deletes; those are its failures.
    const failures = job.result_summary?.failureCount ?? 0;
    const partial = failures > 0;
    return (
      <div
        className={cn(
          "rounded-xl border-2 p-6 text-center",
          partial
            ? "border-amber-200 bg-amber-50"
            : "border-emerald-200 bg-gradient-to-br from-emerald-50 to-teal-50"
        )}
      >
        <div className="flex flex-col items-center gap-3">
          <h3
            className={cn(
              "text-lg font-semibold",
              partial ? "text-amber-900" : "text-emerald-900"
            )}
          >
            {partial
              ? eraseAll
                ? "Sandbox data partly erased"
                : "Test data partly removed"
              : eraseAll
                ? "Sandbox data erased"
                : "Test data removed"}
          </h3>
          <p className={cn("text-sm", partial ? "text-amber-800" : "text-emerald-700")}>
            {partial
              ? partialPurgeOutcome(job, sandboxName, failures)
              : purgeOutcome(job, sandboxName, eraseAll)}
          </p>
          <div className="mt-2 flex gap-2">
            {onViewDetails && (
              <Button size="sm" variant="ghost" onClick={() => onViewDetails(job)}>
                View details
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => (onLoadMore ? onLoadMore() : window.location.reload())}
            >
              Close
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (isCompleted) {
    const cfg = (job.config || {}) as Record<string, unknown>;
    // A load completes even when QuickBooks refused some records (its failures).
    const refused = job.result_summary?.failureCount ?? 0;
    return (
      <div
        className={cn(
          "rounded-xl border-2 p-6 text-center",
          refused > 0
            ? "border-amber-200 bg-amber-50"
            : "border-emerald-200 bg-gradient-to-br from-emerald-50 to-teal-50"
        )}
      >
        <div className="flex flex-col items-center gap-3">
          {refused === 0 && <SuccessFlowSvg className="w-48" />}
          <div>
            <h3
              className={cn(
                "text-lg font-semibold",
                refused > 0 ? "text-amber-900" : "text-emerald-900"
              )}
            >
              {refused > 0 ? "Your company is partly loaded" : "Your company is loaded"}
            </h3>
            <p className={cn("mt-1 text-sm", refused > 0 ? "text-amber-800" : "text-emerald-700")}>
              {refused > 0
                ? `QuickBooks refused ${refused} record(s); everything else was created in ${sandboxName}. Open View details to see which and why.`
                : `${job.entity_count ? `${job.entity_count} records created` : "Your test data is ready"}${
                    connectionName ? ` in ${connectionName}` : " in your QuickBooks sandbox"
                  }.`}
            </p>
            {refused > 0 && onViewDetails && (
              <Button size="sm" variant="ghost" className="mt-2" onClick={() => onViewDetails(job)}>
                View details
              </Button>
            )}
          </div>
          <SandboxNextSteps
            companyName={connectionName}
            startDate={cfg.startDate as string | undefined}
            endDate={cfg.endDate as string | undefined}
            className="w-full max-w-md rounded-lg border border-emerald-200 bg-white/70 p-4"
          />
          <div className="mt-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => (onLoadMore ? onLoadMore() : window.location.reload())}
            >
              Load more data
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // A load whose rollback completed stays failed, but its records are gone: amber, not red.
  const rolledBack = Boolean(job.rolled_back) && status === "failed";

  return (
    <div className="space-y-4 rounded-xl border bg-card p-5">
      {/* Header: title, then the actions and status, so the buttons stay put as the log grows */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {isActive && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
          {isFailed && (
            <AlertCircle
              className={cn("h-4 w-4", rolledBack ? "text-amber-600" : "text-destructive")}
            />
          )}
          <span className="text-sm font-medium">
            {isDownloadJob
              ? "Generating sample files"
              : isRollback
                ? `Rolling back the stopped load in ${sandboxName}`
                : isPurge
                  ? eraseAll
                    ? `Erasing all data in ${sandboxName}`
                    : `Removing test data from ${sandboxName}`
                  : connectionName
                  ? `Loading your company into ${connectionName}`
                  : "Loading your company into the QuickBooks sandbox"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isFinished && onViewDetails && (
            <Button size="sm" variant="ghost" onClick={() => onViewDetails(job)}>
              View details
            </Button>
          )}
          {status === "failed_with_orphans" && onRollback && (
            <Button size="sm" onClick={handleRollback} disabled={rollingBack}>
              <RotateCcw className="mr-1 h-4 w-4" />
              {rollingBack ? "Starting..." : "Roll back"}
            </Button>
          )}
          {isActive && (
            <Button variant="destructive" size="sm" onClick={handleCancel} disabled={cancelling}>
              <X className="mr-1 h-4 w-4" />
              {cancelling ? "Cancelling..." : "Cancel"}
            </Button>
          )}
          {isFinished && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => (onLoadMore ? onLoadMore() : window.location.reload())}
            >
              Close
            </Button>
          )}
          <StatusBadge status={rolledBack ? "rolled_back" : status} />
        </div>
      </div>

      {/* Progress bar */}
      <div className="space-y-1.5">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{message || (isActive ? "Waiting..." : "")}</span>
          <span>
            {step}/{totalSteps}
          </span>
        </div>
        <Progress value={progressPct} />
      </div>

      {/* Error (a rolled-back load says its records are gone) */}
      {error && rolledBack && (
        <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
          {`${error.replace(/\s*Roll back to remove them\.?\s*$/, "")} They have been rolled back.`}
        </div>
      )}
      {error && !rolledBack && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}
      {status === "failed_with_orphans" && !onRollback && (
        <p className="text-xs text-muted-foreground">
          Roll back the records it created from Recent activity.
        </p>
      )}

      {/* Log */}
      {log.length > 0 && (
        <div
          ref={logContainerRef}
          className="max-h-36 overflow-y-auto rounded-md border bg-muted/50 p-3 font-mono text-xs"
        >
          {log.map((entry, i) => (
            <div key={i} className="py-0.5">
              <span className="text-muted-foreground">
                {new Date(entry.timestamp).toLocaleTimeString()}
              </span>{" "}
              {entry.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** What a finished Remove test data or Erase all data did. Accounts always stay, and QuickBooks
 *  cannot delete customers, vendors, employees or items, so those are made inactive. */
function purgeOutcome(job: Job, sandboxName: string, eraseAll: boolean): string {
  const summary = job.result_summary;
  const deleted = summary?.deletedTotal ?? summary?.totalDeleted ?? job.entity_count;
  const whose = eraseAll ? "" : " EasyTestData";
  const count = deleted != null ? `${deleted}${whose} transaction(s)` : `The${whose} transactions`;
  return (
    `${count} were deleted from ${sandboxName}. ` +
    `${eraseAll ? "All" : "Its"} customers, vendors, employees and items were made inactive; accounts stay.`
  );
}

/** A remove or erase where QuickBooks refused some operations: say so, and where to look. */
function partialPurgeOutcome(job: Job, sandboxName: string, failures: number): string {
  const summary = job.result_summary;
  const deleted = summary?.deletedTotal ?? summary?.totalDeleted ?? job.entity_count;
  const done = deleted != null ? `${deleted} transaction(s) were deleted from ${sandboxName}, but ` : "";
  return (
    `${done}${failures} operation(s) failed, so some records remain. ` +
    "Open View details to see which, then run it again."
  );
}

/** What a finished roll back did. QuickBooks cannot delete customers, vendors, employees or
 *  items, so the roll back makes those inactive; they stay in the sandbox. */
function rollbackOutcome(job: Job, sandboxName: string): string {
  const summary = job.result_summary;
  const deleted = summary?.totalDeleted ?? summary?.deletedTotal;
  const inactivated = summary?.totalInactivated;
  if (deleted == null && inactivated == null) {
    return job.entity_count != null
      ? `${job.entity_count} record(s) the stopped load created were rolled back in ${sandboxName}.`
      : `The stopped load was rolled back in ${sandboxName}.`;
  }
  const inactive = inactivated
    ? ` ${inactivated} customer, vendor, employee or item record(s) were made inactive (QuickBooks cannot delete those, so they stay in the sandbox).`
    : "";
  return `${deleted ?? 0} record(s) the stopped load created were deleted from ${sandboxName}.${inactive}`;
}

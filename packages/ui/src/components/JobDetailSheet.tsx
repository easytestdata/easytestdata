import { useCallback, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "./ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { StatusBadge, displayStatus } from "./StatusBadge";
import { JobTypeIcon, jobTypeLabel } from "./svg/JobTypeIcon";
import { JobConfigSummary } from "./job-detail/JobConfigSummary";
import { JobResultSummaryView } from "./job-detail/JobResultSummary";
import { JobDataViewer } from "./job-detail/JobDataViewer";
import { JobProgressLog } from "./job-detail/JobProgressLog";
import { JobFailuresPanel } from "./job-detail/JobFailuresPanel";
import { JobDownloadButtons } from "./job-detail/JobDownloadButtons";
import { SandboxNextSteps } from "./job-detail/SandboxNextSteps";
import { ConfirmDialog } from "./ConfirmDialog";
import { startRollback } from "./job-detail/startRollback";
import { formatDuration, timeAgo } from "../lib/format";
import { useCreateJob, useJob, useJobData } from "@easytestdata/shared/api-hooks";
import { cancelJob } from "@easytestdata/shared/api-client";
import type { CreateJobBody } from "@easytestdata/shared/api-client";
import type { Job, JobResultSummary } from "../types";
import { toast } from "sonner";
import { X, RotateCcw, RefreshCw } from "lucide-react";

interface JobDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: Job | null;
  onJobUpdate?: () => void;
  /** A job started from the sheet (roll back, re-run), so the page can show its progress. */
  onJobStarted?: (job: Job) => void;
  /** The job's sandbox name (job configs do not carry it), from the page's connection list. */
  connectionName?: string;
}

export function JobDetailSheet({
  open,
  onOpenChange,
  job,
  onJobUpdate,
  onJobStarted,
  connectionName
}: JobDetailSheetProps) {
  const [rollingBack, setRollingBack] = useState(false);
  const [confirmLoadAgain, setConfirmLoadAgain] = useState(false);
  // Fetch full detail (includes result.failures) in background
  const { data: fullJob } = useJob(job?.id ?? "", { enabled: open && !!job?.id });

  const displayJob = fullJob ?? job;
  const jobConfig = (displayJob?.config as Record<string, unknown>) ?? {};
  // The sandbox name comes from the connection list; a job config never carries it.
  const config = connectionName ? { ...jobConfig, companyName: connectionName } : jobConfig;
  const resultSummary = (displayJob?.result_summary ??
    (displayJob?.result && typeof displayJob.result === "object"
      ? (displayJob.result as JobResultSummary)
      : null)) as JobResultSummary | null;

  const isActive = displayJob?.status === "running" || displayJob?.status === "pending";
  const fullResult =
    fullJob?.result && typeof fullJob.result === "object"
      ? (fullJob.result as Record<string, unknown>)
      : null;
  // A job that completed while QuickBooks refused some records (purge report, or a load's list).
  const completedFailures =
    resultSummary?.failureCount ??
    (Array.isArray(fullResult?.failures) ? (fullResult.failures as unknown[]).length : 0);
  const hasFailures: boolean =
    !!displayJob?.error ||
    (resultSummary?.failureCount != null && resultSummary.failureCount > 0) ||
    (Array.isArray(fullResult?.failures) && (fullResult.failures as unknown[]).length > 0);

  const {
    data: jobData,
    isLoading: jobDataLoading,
    error: jobDataError
  } = useJobData(displayJob?.id ?? "", {
    enabled:
      open &&
      !!displayJob?.id &&
      !!(resultSummary as JobResultSummary | null)?.artifact &&
      displayJob?.status === "completed"
  });
  const createJob = useCreateJob();

  const handleJobUpdate = useCallback(() => {
    onJobUpdate?.();
  }, [onJobUpdate]);

  async function handleCancel() {
    if (!displayJob?.id) return;
    try {
      await cancelJob(displayJob.id);
      onJobUpdate?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel job");
    }
  }

  async function handleRollback() {
    if (!displayJob?.id || rollingBack) return;
    setRollingBack(true);
    try {
      const started = await startRollback(displayJob.id);
      // Refetch either way: a refused roll back usually means this load changed meanwhile.
      onJobUpdate?.();
      if (started) onJobStarted?.(started);
    } finally {
      setRollingBack(false);
    }
  }

  async function handleRerun() {
    if (!displayJob) return;
    const cfg = displayJob.config as Record<string, unknown> | undefined;
    if (!cfg?.templateId) return;
    // Same configuration, new seed: a re-run draws fresh data rather than repeating the plan.
    const { seed: _seed, ...config } = cfg;
    try {
      const started = await createJob.mutateAsync({
        type: displayJob.type as CreateJobBody["type"],
        connectionId: displayJob.connection_id ?? undefined,
        templateId: cfg.templateId as string,
        config
      });
      toast.success("Loading again with new data...");
      setConfirmLoadAgain(false);
      onJobUpdate?.();
      onJobStarted?.(started as Job);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start loading again");
    }
  }

  if (!displayJob) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <JobTypeIcon type={displayJob.type} className="h-5 w-5" />
            <span>{jobTypeLabel(displayJob)}</span>
            <StatusBadge status={displayStatus(displayJob)} />
          </SheetTitle>
          <SheetDescription>
            {timeAgo(displayJob.created_at)}
            {displayJob.started_at &&
              displayJob.completed_at &&
              ` \u00b7 ${formatDuration(displayJob.started_at, displayJob.completed_at)}`}
          </SheetDescription>
        </SheetHeader>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2 mt-4">
          <JobDownloadButtons job={displayJob} className="contents" />
          {displayJob.status === "completed" &&
            displayJob.type === "load" &&
            !!(displayJob.config as Record<string, unknown>)?.templateId && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirmLoadAgain(true)}
                disabled={createJob.isPending}
              >
                <RefreshCw className="mr-1 h-3 w-3" />
                Load again (new data)
              </Button>
            )}
          {displayJob.status === "failed_with_orphans" && (
            <Button variant="secondary" size="sm" onClick={handleRollback} disabled={rollingBack}>
              <RotateCcw className="mr-1 h-3 w-3" />
              {rollingBack ? "Starting..." : "Roll back"}
            </Button>
          )}
          {isActive && (
            <Button variant="destructive" size="sm" onClick={handleCancel}>
              <X className="mr-1 h-3 w-3" />
              Cancel
            </Button>
          )}
        </div>

        <Separator className="my-4" />

        {/* Tabs */}
        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="progress">Progress</TabsTrigger>
            {hasFailures ? <TabsTrigger value="failures">Failures</TabsTrigger> : null}
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            {displayJob.status === "completed" && completedFailures > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <p className="font-medium">
                  Completed with errors: QuickBooks refused {completedFailures} operation(s).
                </p>
                <p className="mt-1">
                  {displayJob.type === "load"
                    ? "Everything else was created. "
                    : "Those records are still in the sandbox. "}
                  The Failures tab lists each record with QuickBooks&apos; reason (for example, a
                  customer with an open balance cannot be made inactive).{" "}
                  {displayJob.type === "purge"
                    ? "Fix them in QuickBooks, or run it again to retry."
                    : ""}
                </p>
              </div>
            )}
            {displayJob.status === "completed" && displayJob.type === "load" && (
              <SandboxNextSteps
                companyName={config.companyName as string | undefined}
                startDate={config.startDate as string | undefined}
                endDate={config.endDate as string | undefined}
                className="rounded-lg border bg-muted/30 p-4"
              />
            )}
            <JobConfigSummary config={config} type={displayJob.type} />
            {resultSummary && displayJob.status === "completed" && (
              <>
                <Separator />
                <JobResultSummaryView result={resultSummary} type={displayJob.type} />
              </>
            )}
            {resultSummary?.artifact && displayJob.status === "completed" && (
              <>
                <Separator />
                <JobDataViewer
                  data={jobData as Record<string, unknown> | undefined}
                  isLoading={jobDataLoading}
                  error={jobDataError}
                />
              </>
            )}
          </TabsContent>

          <TabsContent value="progress">
            <JobProgressLog job={displayJob} onJobUpdate={handleJobUpdate} />
          </TabsContent>

          {hasFailures ? (
            <TabsContent value="failures">
              <JobFailuresPanel job={fullJob ?? displayJob} />
            </TabsContent>
          ) : null}
        </Tabs>
      </SheetContent>
      <ConfirmDialog
        open={confirmLoadAgain}
        onOpenChange={setConfirmLoadAgain}
        title="Load again with new data?"
        description={loadAgainDescription(displayJob, connectionName)}
        confirmLabel="Load again"
        onConfirm={handleRerun}
        pending={createJob.isPending}
        pendingLabel="Starting..."
      />
    </Sheet>
  );
}

/** What "Load again (new data)" will do: same settings and a new seed, so different records,
 *  and whatever the original load's "remove existing test data first" choice was. */
export function loadAgainDescription(job: Job, sandboxName?: string): string {
  const cfg = (job.config || {}) as Record<string, unknown>;
  const sandbox = sandboxName || "the sandbox";
  const size = job.entity_count ? `about ${job.entity_count.toLocaleString("en-US")} ` : "";
  const fresh = `This loads a new company with the same settings but different, newly generated data (${size}records).`;
  if (cfg.purgeMode === "all") {
    return `${fresh} It first erases all data in ${sandbox}, as the original load did: every transaction of the types EasyTestData loads is deleted, including ones you entered by hand, and all customers, vendors, employees and items are made inactive. Accounts stay.`;
  }
  if (cfg.purgeMode === "generated") {
    return `${fresh} It first removes the existing test data (tagged ${(cfg.tag as string) || "EZTD"}) from ${sandbox}, as the original load did.`;
  }
  return `${fresh} It adds them to ${sandbox} on top of what is already there.`;
}

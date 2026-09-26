import { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import { StatusBadge, displayStatus } from "./StatusBadge";
import { jobTypeLabel } from "./svg/JobTypeIcon";
import { cancelJob } from "@easytestdata/shared/api-client";
import { useJob } from "@easytestdata/shared/api-hooks";
import { readJobProgress, useJobProgressLog } from "./job-detail/useJobProgressLog";
import { startRollback } from "./job-detail/startRollback";
import type { Job } from "../types";
import { X, RotateCcw } from "lucide-react";

interface JobProgressModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: Job | null;
  onJobUpdate?: () => void;
  /** A roll back started from the modal, so the page can show its progress. */
  onJobStarted?: (job: Job) => void;
}

export function JobProgressModal({
  open,
  onOpenChange,
  job: initialJob,
  onJobUpdate,
  onJobStarted
}: JobProgressModalProps) {
  // Poll the job while the modal is open; the job it was opened with shows until then.
  const { data: polledJob } = useJob(initialJob?.id ?? "", { enabled: open && !!initialJob?.id });
  const job = polledJob ?? initialJob;
  const [step, setStep] = useState(0);
  const [totalSteps, setTotalSteps] = useState(0);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState(job?.status || "pending");
  const [error, setError] = useState<string | null>(null);
  const log = useJobProgressLog(open ? job : null, onJobUpdate);
  const [cancelling, setCancelling] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!job) return;
    setStatus(job.status);
    setError(job.error || null);
    const progress = readJobProgress(job);
    setStep(progress.step);
    setTotalSteps(progress.totalSteps);
    setMessage(progress.message);
  }, [job]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  async function handleCancel() {
    if (!job?.id) return;
    setCancelling(true);
    try {
      const updated = await cancelJob(job.id);
      setStatus(updated?.status ?? "cancelling");
      if (updated?.status !== "cancelled") setMessage("Cancelling...");
      onJobUpdate?.();
    } catch {
      // Ignore cancel errors
    } finally {
      setCancelling(false);
    }
  }

  function handleClose() {
    setStep(0);
    setTotalSteps(0);
    setMessage("");
    setError(null);
    setCancelling(false);
    onOpenChange(false);
  }

  const progressPct = totalSteps > 0 ? Math.round((step / totalSteps) * 100) : 0;
  const isActive = status === "running" || status === "pending";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Progress
            <StatusBadge status={job ? displayStatus({ ...job, status }) : status} />
          </DialogTitle>
          <DialogDescription>
            {job ? jobTypeLabel(job) : ""} &middot; Started{" "}
            {job?.created_at ? new Date(job.created_at).toLocaleString() : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Progress bar */}
          <div className="space-y-2">
            <div className="flex justify-between text-sm text-muted-foreground">
              <span>{message || (isActive ? "Waiting..." : "")}</span>
              <span>
                {step}/{totalSteps}
              </span>
            </div>
            <Progress value={progressPct} />
          </div>

          {/* Error message */}
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
          )}

          {/* Scrolling log */}
          {log.length > 0 && (
            <div className="max-h-48 overflow-y-auto overflow-x-hidden rounded-md border bg-muted/50 p-3 font-mono text-xs break-all">
              {log.map((entry, i) => (
                <div key={i} className="py-0.5">
                  <span className="text-muted-foreground">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>{" "}
                  {entry.message}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2">
            {status === "failed_with_orphans" && (
              <Button
                variant="secondary"
                size="sm"
                disabled={rollingBack}
                onClick={async () => {
                  if (!job?.id || rollingBack) return;
                  setRollingBack(true);
                  try {
                    const started = await startRollback(job.id);
                    onJobUpdate?.();
                    if (started) onJobStarted?.(started);
                  } finally {
                    setRollingBack(false);
                  }
                }}
              >
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
            <Button variant="outline" size="sm" onClick={handleClose}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

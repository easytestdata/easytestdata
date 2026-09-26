import { useState, useEffect, useRef } from "react";
import { Progress } from "../ui/progress";
import { formatDuration } from "../../lib/format";
import { CheckCircle2, XCircle, Clock } from "lucide-react";
import { readJobProgress, useJobProgressLog } from "./useJobProgressLog";
import type { Job } from "../../types";

interface JobProgressLogProps {
  job: Job;
  onJobUpdate?: () => void;
}

export function JobProgressLog({ job, onJobUpdate }: JobProgressLogProps) {
  const [step, setStep] = useState(0);
  const [totalSteps, setTotalSteps] = useState(0);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState(job.status);
  const [error, setError] = useState<string | null>(job.error || null);
  const log = useJobProgressLog(job, onJobUpdate);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
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

  const isActive = status === "running" || status === "pending";
  const isFinished =
    status === "completed" ||
    status === "failed" ||
    status === "failed_with_orphans" ||
    status === "cancelled";
  const progressPct =
    isFinished && !isActive
      ? status === "completed"
        ? 100
        : totalSteps > 0
          ? Math.round((step / totalSteps) * 100)
          : 0
      : totalSteps > 0
        ? Math.round((step / totalSteps) * 100)
        : 0;

  // For finished jobs with no live log, show a summary instead of an empty log box
  if (isFinished && log.length === 0) {
    const duration =
      job.started_at && job.completed_at ? formatDuration(job.started_at, job.completed_at) : null;

    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <Progress value={progressPct} />
        </div>

        {status === "completed" && (
          <div className="flex items-start gap-3 rounded-md border bg-muted/30 p-4">
            <CheckCircle2 className="h-5 w-5 text-green-500 mt-0.5 shrink-0" />
            <div className="space-y-1 text-sm">
              <div className="font-medium">Job completed successfully</div>
              {duration && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  <span>Duration: {duration}</span>
                </div>
              )}
              {totalSteps > 0 && (
                <div className="text-muted-foreground">
                  {totalSteps} {totalSteps === 1 ? "step" : "steps"} completed
                </div>
              )}
            </div>
          </div>
        )}

        {(status === "failed" || status === "failed_with_orphans") && (
          <div className="space-y-3">
            <div className="flex items-start gap-3 rounded-md border border-destructive/20 bg-destructive/5 p-4">
              <XCircle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
              <div className="space-y-1 text-sm">
                <div className="font-medium">Job failed</div>
                {error && <div className="text-destructive">{error}</div>}
                {duration && (
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" />
                    <span>Duration: {duration}</span>
                  </div>
                )}
                {totalSteps > 0 && step > 0 && (
                  <div className="text-muted-foreground">
                    Failed at step {step} of {totalSteps}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {status === "cancelled" && (
          <div className="flex items-start gap-3 rounded-md border bg-muted/30 p-4">
            <XCircle className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
            <div className="space-y-1 text-sm">
              <div className="font-medium">Job was cancelled</div>
              {totalSteps > 0 && step > 0 && (
                <div className="text-muted-foreground">
                  Cancelled at step {step} of {totalSteps}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
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
      <div className="max-h-72 overflow-y-auto overflow-x-hidden rounded-md border bg-muted/50 p-3 font-mono text-xs break-all">
        {log.length === 0 ? (
          <span className="text-muted-foreground">Waiting for progress updates...</span>
        ) : (
          log.map((entry, i) => (
            <div key={i} className="py-0.5">
              <span className="text-muted-foreground">
                {new Date(entry.timestamp).toLocaleTimeString()}
              </span>{" "}
              {entry.message}
            </div>
          ))
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}

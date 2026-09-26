import { useEffect, useRef, useState } from "react";
import { ACTIVE_JOB_STATUSES } from "@easytestdata/shared/query-keys";
import type { Job } from "../../types";

export interface JobLogEntry {
  timestamp: string;
  message: string;
}

/** The `{ step, totalSteps, message }` a worker last wrote to `jobs.progress`. */
export function readJobProgress(job: Job | null) {
  const raw = job?.progress;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  const p = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  return {
    step: Number(p.step) || 0,
    totalSteps: Number(p.totalSteps) || 0,
    message: typeof p.message === "string" ? p.message : ""
  };
}

function finishedMessage(job: Job) {
  if (job.status === "completed") return "Job completed successfully";
  if (job.status === "cancelled") return "Job cancelled";
  return `Failed: ${job.error || "Unknown error"}`;
}

/**
 * A running log built from a polled job: each new progress message seen while the job is
 * active adds a line, and the job finishing while it is being watched adds a closing line
 * (and calls `onFinished`). A job that was already finished when first seen has no log.
 */
export function useJobProgressLog(job: Job | null, onFinished?: () => void) {
  const [log, setLog] = useState<JobLogEntry[]>([]);
  const seen = useRef<{ id?: string; status?: string; message?: string }>({});
  const { message } = readJobProgress(job);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  useEffect(() => {
    if (!job) {
      seen.current = {};
      return;
    }
    const prev = seen.current;
    const sameJob = prev.id === job.id;
    const active = ACTIVE_JOB_STATUSES.includes(job.status);
    const lines: string[] = [];
    if (active && message && (!sameJob || message !== prev.message)) lines.push(message);
    const finished =
      sameJob && !!prev.status && ACTIVE_JOB_STATUSES.includes(prev.status) && !active;
    if (finished) lines.push(finishedMessage(job));
    seen.current = { id: job.id, status: job.status, message };

    const timestamp = new Date().toISOString();
    const entries = lines.map((line) => ({ timestamp, message: line }));
    if (!sameJob) setLog(entries);
    else if (entries.length > 0) setLog((current) => [...current, ...entries]);
    if (finished) onFinishedRef.current?.();
  }, [job, message]);

  return log;
}

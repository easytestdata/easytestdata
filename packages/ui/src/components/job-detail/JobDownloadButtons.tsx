import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { downloadJob, type JobDownloadFormat } from "@easytestdata/shared/api-client";
import { Button } from "../ui/button";
import type { Job, JobResultSummary } from "../../types";

const DOWNLOAD_JOB_TYPES = new Set(["generate", "export"]);

/** Formats a completed job can be downloaded in, based on the artifacts the worker wrote. */
export function getJobDownloadFormats(job: Job | null | undefined): JobDownloadFormat[] {
  if (!job || job.status !== "completed" || !DOWNLOAD_JOB_TYPES.has(job.type)) return [];
  const summary = (job.result_summary ??
    (job.result && typeof job.result === "object" ? job.result : null)) as JobResultSummary | null;
  if (!summary) return [];
  const formats: JobDownloadFormat[] = [];
  for (const format of ["json", "csv"] as const) {
    if (summary.artifacts?.[format]) formats.push(format);
  }
  return formats;
}

interface JobDownloadButtonsProps {
  job: Job | null | undefined;
  size?: "sm" | "default";
  className?: string;
}

export function JobDownloadButtons({ job, size = "sm", className }: JobDownloadButtonsProps) {
  const [pending, setPending] = useState<JobDownloadFormat | null>(null);
  const formats = getJobDownloadFormats(job);
  if (!job || formats.length === 0) return null;

  async function handleDownload(format: JobDownloadFormat) {
    if (!job || pending) return;
    setPending(format);
    try {
      await downloadJob(job.id, format);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download failed");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className={className ?? "flex flex-wrap gap-2"}>
      {formats.map((format) => (
        <Button
          key={format}
          variant={format === "json" ? "default" : "outline"}
          size={size}
          onClick={() => handleDownload(format)}
          disabled={pending !== null}
        >
          {pending === format ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Download className="mr-1 h-3 w-3" />
          )}
          Download {format === "csv" ? "CSV (zip)" : "JSON"}
        </Button>
      ))}
    </div>
  );
}

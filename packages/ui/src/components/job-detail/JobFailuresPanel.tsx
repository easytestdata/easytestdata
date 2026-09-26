import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { AlertCircle } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import type { Job } from "../../types";

interface JobFailuresPanelProps {
  job: Job;
}

interface Failure {
  entity?: string;
  type?: string;
  message?: string;
  error?: string;
}

export function JobFailuresPanel({ job }: JobFailuresPanelProps) {
  const result =
    job.result && typeof job.result === "object" ? (job.result as Record<string, unknown>) : null;
  const failures = (result?.failures as Failure[] | undefined) ?? [];
  const failureCount = (result?.failureCount as number | undefined) ?? failures.length;

  return (
    <div className="space-y-4">
      {job.error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{job.error}</AlertDescription>
        </Alert>
      )}

      {failureCount > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {failureCount} failure{failureCount !== 1 ? "s" : ""} recorded
          </p>
          {failures.length > 0 && (
            <div className="max-h-72 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Record</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {failures.map((f, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-xs font-mono">
                        {f.entity || f.type || "-"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {f.message || f.error || "Unknown error"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      {!job.error && failureCount === 0 && (
        <p className="text-sm text-muted-foreground">
          No errors or failures recorded for this job.
        </p>
      )}
    </div>
  );
}

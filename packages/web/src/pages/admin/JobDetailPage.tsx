import { useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, XCircle, RotateCcw, AlertTriangle } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Badge,
  Skeleton
} from "@easytestdata/ui";
import { toast } from "sonner";
import { getAdminJob, cancelAdminJob, retryAdminJob, forceFailJob } from "@/api/admin";
import { ACTIVE_JOB_STATUSES } from "@easytestdata/shared/query-keys";

export function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [actionPending, setActionPending] = useState(false);
  const actionPendingRef = useRef(false);

  const clearPendingAction = () => {
    actionPendingRef.current = false;
    setActionPending(false);
  };

  const runJobAction = (mutate: () => void) => {
    if (actionPendingRef.current) return;
    actionPendingRef.current = true;
    setActionPending(true);
    mutate();
  };

  const { data: job, isLoading } = useQuery({
    queryKey: ["admin", "job", id],
    queryFn: () => getAdminJob(id!),
    enabled: !!id,
    refetchInterval: (query) => {
      const j = query.state.data;
      if (j && ACTIVE_JOB_STATUSES.includes(j.status)) return 3000;
      return false;
    }
  });

  const cancelMut = useMutation({
    mutationFn: () => cancelAdminJob(id!),
    onSuccess: () => {
      toast.success("Cancelled");
      return qc.invalidateQueries({ queryKey: ["admin", "job", id] });
    },
    onSettled: clearPendingAction
  });
  const retryMut = useMutation({
    mutationFn: () => retryAdminJob(id!),
    onSuccess: () => {
      toast.success("Retried");
      return Promise.all([
        qc.invalidateQueries({ queryKey: ["admin", "job", id] }),
        qc.invalidateQueries({ queryKey: ["admin", "jobs"] })
      ]);
    },
    onSettled: clearPendingAction
  });
  const forceFailMut = useMutation({
    mutationFn: () => forceFailJob(id!),
    onSuccess: (res) => {
      toast.success(res.message);
      return qc.invalidateQueries({ queryKey: ["admin", "job", id] });
    },
    onSettled: clearPendingAction
  });

  if (isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  if (!job) return <div className="text-center py-8 text-muted-foreground">Job not found</div>;

  const duration =
    job.started_at && job.completed_at
      ? Math.round(
          (new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()) / 1000
        )
      : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/admin/jobs">
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold font-mono">{job.id.slice(0, 12)}...</h1>
          <Badge variant="outline">
            {job.type} - {job.status}
          </Badge>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {["pending", "running"].includes(job.status) && (
            <Button
              size="sm"
              variant="destructive"
              disabled={actionPending}
              onClick={() => runJobAction(() => cancelMut.mutate())}
            >
              <XCircle className="h-3.5 w-3.5 mr-1" />
              Cancel
            </Button>
          )}
          {["failed", "failed_with_orphans"].includes(job.status) && (
            <Button
              size="sm"
              variant="outline"
              disabled={actionPending}
              onClick={() => runJobAction(() => retryMut.mutate())}
            >
              <RotateCcw className="h-3.5 w-3.5 mr-1" />
              Retry
            </Button>
          )}
          {job.status === "running" && (
            <Button
              size="sm"
              variant="destructive"
              disabled={actionPending}
              onClick={() => runJobAction(() => forceFailMut.mutate())}
            >
              <AlertTriangle className="h-3.5 w-3.5 mr-1" />
              Force Fail
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">ID</span>
              <span className="font-mono text-xs">{job.id}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Type</span>
              <span>{job.type}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Status</span>
              <Badge variant="outline">{job.status}</Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Team</span>
              <span>{job.team_name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Records</span>
              <span>{job.entity_count ?? "-"}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Timing</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Created</span>
              <span>{new Date(job.created_at).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Started</span>
              <span>{job.started_at ? new Date(job.started_at).toLocaleString() : "-"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Completed</span>
              <span>{job.completed_at ? new Date(job.completed_at).toLocaleString() : "-"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Duration</span>
              <span>{duration !== null ? `${duration}s` : "-"}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {job.error && (
        <Card className="border-red-200">
          <CardHeader>
            <CardTitle className="text-sm text-red-800">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs text-red-700 whitespace-pre-wrap font-mono bg-red-50 p-3 rounded">
              {job.error}
            </pre>
          </CardContent>
        </Card>
      )}

      {job.config ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Config Snapshot</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs whitespace-pre-wrap font-mono bg-muted p-3 rounded max-h-96 overflow-auto">
              {String(JSON.stringify(job.config, null, 2))}
            </pre>
          </CardContent>
        </Card>
      ) : null}

      {job.progress ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Progress</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs whitespace-pre-wrap font-mono bg-muted p-3 rounded max-h-64 overflow-auto">
              {String(JSON.stringify(job.progress, null, 2))}
            </pre>
          </CardContent>
        </Card>
      ) : null}

      {job.result ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Result</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs whitespace-pre-wrap font-mono bg-muted p-3 rounded max-h-64 overflow-auto">
              {String(JSON.stringify(job.result, null, 2))}
            </pre>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

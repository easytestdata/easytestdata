import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { XCircle, RotateCcw, AlertTriangle } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton
} from "@easytestdata/ui";
import { toast } from "sonner";
import {
  getAdminJobs,
  cancelAdminJob,
  retryAdminJob,
  forceFailJob,
  getJobStats,
  type AdminJob
} from "@/api/admin";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  AreaChart,
  Area,
  Cell
} from "recharts";

const STATUS_COLORS: Record<string, string> = {
  completed: "bg-green-100 text-green-800",
  running: "bg-blue-100 text-blue-800",
  cancelling: "bg-yellow-100 text-yellow-800",
  pending: "bg-yellow-100 text-yellow-800",
  failed: "bg-red-100 text-red-800",
  failed_with_orphans: "bg-red-100 text-red-800",
  cancelled: "bg-gray-100 text-gray-800"
};

const CHART_STATUS_COLORS: Record<string, string> = {
  completed: "#10b981",
  running: "#3b82f6",
  cancelling: "#f59e0b",
  pending: "#f59e0b",
  failed: "#ef4444",
  failed_with_orphans: "#ef4444",
  cancelled: "#6b7280"
};

export function JobManagementPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const actionPendingRef = useRef(false);

  const clearPendingAction = () => {
    actionPendingRef.current = false;
    setActionPending(false);
  };

  const runJobAction = (jobId: string, mutate: (id: string) => void) => {
    if (actionPendingRef.current) return;
    actionPendingRef.current = true;
    setActionPending(true);
    mutate(jobId);
  };

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ["admin", "jobs", "stats"],
    queryFn: getJobStats,
    refetchInterval: 30000
  });

  const failureRateData = stats?.failureRate.map((d) => ({
    date: d.date,
    rate: d.total > 0 ? Math.round((d.failed / d.total) * 100) : 0
  }));

  const params: Record<string, string> = { page: String(page), limit: "50" };
  if (status) params.status = status;
  if (type) params.type = type;

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "jobs", params],
    queryFn: () => getAdminJobs(params),
    refetchInterval: 10000
  });

  const cancelMut = useMutation({
    mutationFn: cancelAdminJob,
    onSuccess: () => {
      toast.success("Job cancelled");
      return qc.invalidateQueries({ queryKey: ["admin", "jobs"] });
    },
    onSettled: clearPendingAction
  });
  const retryMut = useMutation({
    mutationFn: retryAdminJob,
    onSuccess: () => {
      toast.success("Job retried");
      return qc.invalidateQueries({ queryKey: ["admin", "jobs"] });
    },
    onSettled: clearPendingAction
  });
  const forceFailMut = useMutation({
    mutationFn: forceFailJob,
    onSuccess: (res) => {
      toast.success(res.message);
      return qc.invalidateQueries({ queryKey: ["admin", "jobs"] });
    },
    onSettled: clearPendingAction
  });

  const totalPages = data ? Math.ceil(data.total / data.limit) : 0;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Jobs</h1>
      {/* Stats charts */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Status Breakdown (30d)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-48">
              {statsLoading ? (
                <Skeleton className="h-full" />
              ) : stats?.statusBreakdown && stats.statusBreakdown.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.statusBreakdown} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                    <YAxis dataKey="status" type="category" tick={{ fontSize: 11 }} width={100} />
                    <Tooltip contentStyle={{ fontSize: 12 }} />
                    <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                      {stats.statusBreakdown.map((entry, i) => (
                        <Cell key={i} fill={CHART_STATUS_COLORS[entry.status] || "#6b7280"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  No job data yet
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Avg Duration by Type (30d)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-48">
              {statsLoading ? (
                <Skeleton className="h-full" />
              ) : stats?.avgDuration && stats.avgDuration.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.avgDuration} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}s`} />
                    <YAxis dataKey="type" type="category" tick={{ fontSize: 11 }} width={80} />
                    <Tooltip
                      contentStyle={{ fontSize: 12 }}
                      formatter={(v) => [`${v}s`, "Avg Duration"]}
                    />
                    <Bar dataKey="avg_seconds" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  No duration data yet
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Failure Rate (30d)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-48">
              {statsLoading ? (
                <Skeleton className="h-full" />
              ) : failureRateData && failureRateData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={failureRateData}>
                    <defs>
                      <linearGradient id="failGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="date"
                      tickFormatter={(v) =>
                        new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                      }
                      tick={{ fontSize: 11 }}
                    />
                    <YAxis
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v) => `${v}%`}
                      domain={[0, "auto"]}
                    />
                    <Tooltip
                      contentStyle={{ fontSize: 12 }}
                      labelFormatter={(v) => new Date(String(v)).toLocaleDateString()}
                      formatter={(v) => [`${v}%`, "Failure Rate"]}
                    />
                    <Area
                      type="monotone"
                      dataKey="rate"
                      stroke="#ef4444"
                      fill="url(#failGrad)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  No failure data yet
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 pt-4 pb-4">
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v === "all" ? "" : v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-36 h-9">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="running">Running</SelectItem>
              <SelectItem value="cancelling">Cancelling</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={type}
            onValueChange={(v) => {
              setType(v === "all" ? "" : v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-36 h-9">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="generate">Generate</SelectItem>
              <SelectItem value="load">Load</SelectItem>
              <SelectItem value="purge">Purge</SelectItem>
              <SelectItem value="export">Export</SelectItem>
              <SelectItem value="rollback">Rollback</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Records</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead className="w-28">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.jobs.map((job: AdminJob) => {
                  const duration =
                    job.started_at && job.completed_at
                      ? Math.round(
                          (new Date(job.completed_at).getTime() -
                            new Date(job.started_at).getTime()) /
                            1000
                        )
                      : null;
                  return (
                    <TableRow key={job.id}>
                      <TableCell>
                        <Link
                          to={`/admin/jobs/${job.id}`}
                          className="font-mono text-xs text-primary hover:underline"
                        >
                          {job.id.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm">
                        {job.team_name || job.team_id?.slice(0, 8)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {job.type}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge className={`text-xs ${STATUS_COLORS[job.status] || ""}`}>
                          {job.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{job.entity_count ?? "-"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(job.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {duration !== null ? `${duration}s` : "-"}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          {["pending", "running"].includes(job.status) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 w-6 p-0"
                              title="Cancel"
                              disabled={actionPending}
                              onClick={() => runJobAction(job.id, cancelMut.mutate)}
                            >
                              <XCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {["failed", "failed_with_orphans"].includes(job.status) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 w-6 p-0"
                              title="Retry"
                              disabled={actionPending}
                              onClick={() => runJobAction(job.id, retryMut.mutate)}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {job.status === "running" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 w-6 p-0 text-destructive"
                              title="Force Fail"
                              disabled={actionPending}
                              onClick={() => runJobAction(job.id, forceFailMut.mutate)}
                            >
                              <AlertTriangle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {data?.jobs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                      No jobs found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{data?.total} jobs total</p>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

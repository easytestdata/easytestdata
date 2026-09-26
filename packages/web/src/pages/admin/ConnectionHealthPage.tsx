import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2, Activity } from "lucide-react";
import {
  Card,
  CardContent,
  Button,
  Badge,
  Switch,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Skeleton
} from "@easytestdata/ui";
import { toast } from "sonner";
import {
  getAdminConnections,
  testAdminConnection,
  deleteAdminConnection,
  type AdminConnection
} from "@/api/admin";

function healthColor(daysIdle: number) {
  if (daysIdle < 7) return "bg-green-100 text-green-800";
  if (daysIdle < 60) return "bg-yellow-100 text-yellow-800";
  return "bg-red-100 text-red-800";
}

export function ConnectionHealthPage() {
  const qc = useQueryClient();
  const [staleOnly, setStaleOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [connectionActionPending, setConnectionActionPending] = useState(false);
  const connectionActionPendingRef = useRef(false);

  const clearConnectionActionPending = () => {
    connectionActionPendingRef.current = false;
    setConnectionActionPending(false);
  };

  const runConnectionAction = (action: () => void) => {
    if (connectionActionPendingRef.current) return;
    connectionActionPendingRef.current = true;
    setConnectionActionPending(true);
    action();
  };

  const params: Record<string, string> = { page: String(page), limit: "50" };
  if (staleOnly) params.stale = "true";

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "connections", params],
    queryFn: () => getAdminConnections(params)
  });

  const testMut = useMutation({
    mutationFn: (id: string) => testAdminConnection(id),
    onSuccess: (data) => toast.success(`Connection OK: ${data.companyName}`),
    onError: () => toast.error("Connection test failed"),
    onSettled: clearConnectionActionPending
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteAdminConnection(id),
    onSuccess: () => {
      toast.success("Connection removed");
      return qc.invalidateQueries({ queryKey: ["admin", "connections"] });
    },
    onSettled: clearConnectionActionPending
  });

  const totalPages = data ? Math.ceil(data.total / data.limit) : 0;
  const rowActionPending = connectionActionPending || testMut.isPending || deleteMut.isPending;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Connection Health</h1>
      <Card>
        <CardContent className="flex items-center gap-3 pt-4 pb-4">
          <div className="flex items-center gap-2">
            <Switch
              id="stale"
              checked={staleOnly}
              onCheckedChange={(v) => {
                setStaleOnly(v);
                setPage(1);
              }}
            />
            <Label htmlFor="stale" className="text-sm">
              Show stale only (60+ days idle)
            </Label>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead>Realm ID</TableHead>
                  <TableHead>Health</TableHead>
                  <TableHead>Connected</TableHead>
                  <TableHead>Last Used</TableHead>
                  <TableHead>Jobs</TableHead>
                  <TableHead className="w-24">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.connections.map((conn: AdminConnection) => (
                  <TableRow key={conn.id}>
                    <TableCell className="font-medium">{conn.company_name}</TableCell>
                    <TableCell className="text-sm">{conn.team_name}</TableCell>
                    <TableCell className="font-mono text-xs">{conn.realm_id}</TableCell>
                    <TableCell>
                      <Badge className={`text-xs ${healthColor(conn.days_idle)}`}>
                        {conn.days_idle < 7 ? "Healthy" : conn.days_idle < 60 ? "Idle" : "Stale"} (
                        {conn.days_idle}d)
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(conn.connected_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {conn.last_used_at
                        ? new Date(conn.last_used_at).toLocaleDateString()
                        : "Never"}
                    </TableCell>
                    <TableCell>{conn.job_count}</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0"
                          title="Test"
                          aria-label={`Test ${conn.company_name}`}
                          onClick={() => runConnectionAction(() => testMut.mutate(conn.id))}
                          disabled={rowActionPending}
                        >
                          <Activity className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0 text-destructive"
                          title="Delete"
                          aria-label={`Delete ${conn.company_name}`}
                          onClick={() => runConnectionAction(() => deleteMut.mutate(conn.id))}
                          disabled={rowActionPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {data?.connections.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                      No connections found
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
          <p className="text-sm text-muted-foreground">{data?.total} connections total</p>
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

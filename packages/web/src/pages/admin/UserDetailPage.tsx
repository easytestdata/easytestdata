import { useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban, Key } from "lucide-react";
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
  Skeleton
} from "@easytestdata/ui";
import { toast } from "sonner";
import {
  getAdminUser,
  suspendUser,
  unsuspendUser,
  revokeUserSessions
} from "@/api/admin";

export function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [actionPending, setActionPending] = useState(false);
  const actionPendingRef = useRef(false);

  const clearPendingAction = () => {
    actionPendingRef.current = false;
    setActionPending(false);
  };

  const runUserAction = (mutate: () => void) => {
    if (actionPendingRef.current) return;
    actionPendingRef.current = true;
    setActionPending(true);
    mutate();
  };

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "user", id],
    queryFn: () => getAdminUser(id!),
    enabled: !!id
  });

  const suspendMut = useMutation({
    mutationFn: () => suspendUser(id!, "Suspended by admin"),
    onSuccess: () => {
      toast.success("User suspended");
      return qc.invalidateQueries({ queryKey: ["admin", "user", id] });
    },
    onSettled: clearPendingAction
  });
  const unsuspendMut = useMutation({
    mutationFn: () => unsuspendUser(id!),
    onSuccess: () => {
      toast.success("User unsuspended");
      return qc.invalidateQueries({ queryKey: ["admin", "user", id] });
    },
    onSettled: clearPendingAction
  });
  const revokeMut = useMutation({
    mutationFn: () => revokeUserSessions(id!),
    onSuccess: () => toast.success("All sessions revoked"),
    onSettled: clearPendingAction
  });

  if (isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  if (!data) return <div className="text-center py-8 text-muted-foreground">User not found</div>;

  const { user, teams, recentJobs } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/admin/users">
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">{user.display_name || user.email}</h1>
          <p className="text-sm text-muted-foreground">{user.email}</p>
        </div>
        <div className="ml-auto flex gap-2">
          {user.suspended_at ? (
            <Button
              size="sm"
              onClick={() => runUserAction(() => unsuspendMut.mutate())}
              disabled={actionPending || unsuspendMut.isPending}
            >
              Unsuspend
            </Button>
          ) : (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => runUserAction(() => suspendMut.mutate())}
              disabled={actionPending || suspendMut.isPending}
            >
              <Ban className="h-3.5 w-3.5 mr-1" />
              Suspend
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Profile */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Profile</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">ID</span>
              <span className="font-mono text-xs">{user.id}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Provider</span>
              <span>{user.oauth_provider || "-"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Status</span>
              {user.suspended_at ? (
                <Badge variant="destructive" className="text-xs">
                  Suspended
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-xs">
                  Active
                </Badge>
              )}
            </div>
            {user.suspended_reason && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Suspend Reason</span>
                <span>{user.suspended_reason}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Admin</span>
              <span>{user.is_admin ? "Yes" : "No"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Created</span>
              <span>{new Date(user.created_at).toLocaleString()}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Teams */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Teams ({teams.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Team</TableHead>
                <TableHead>Role</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teams.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>{t.name}</TableCell>
                  <TableCell>{t.role}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Recent Jobs */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Recent Jobs ({recentJobs.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Records</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentJobs.map((j) => (
                <TableRow key={j.id}>
                  <TableCell>
                    <Link
                      to={`/admin/jobs/${j.id}`}
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      {j.id.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell>{j.type}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">
                      {j.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{j.entity_count ?? "-"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(j.created_at).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Session management */}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={() => runUserAction(() => revokeMut.mutate())}
          disabled={actionPending || revokeMut.isPending}
        >
          <Key className="h-3.5 w-3.5 mr-1" />
          Revoke All Sessions
        </Button>
      </div>
    </div>
  );
}

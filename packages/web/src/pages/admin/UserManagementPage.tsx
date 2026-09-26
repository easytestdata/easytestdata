import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Search, Shield, Ban, Download } from "lucide-react";
import {
  Card,
  CardContent,
  Input,
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
import { getAdminUsers, suspendUser, unsuspendUser, type AdminUser } from "@/api/admin";
import { adminDownload } from "@/api/client";

export function UserManagementPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("");
  const [suspended, setSuspended] = useState("");
  const [userActionPending, setUserActionPending] = useState(false);
  const userActionPendingRef = useRef(false);

  const clearUserActionPending = () => {
    userActionPendingRef.current = false;
    setUserActionPending(false);
  };

  const runUserAction = (action: () => void) => {
    if (userActionPendingRef.current) return;
    userActionPendingRef.current = true;
    setUserActionPending(true);
    action();
  };

  const handleExport = async () => {
    if (userActionPendingRef.current) return;
    userActionPendingRef.current = true;
    setUserActionPending(true);
    try {
      await adminDownload("/admin/users/export?format=csv", "users.csv");
    } catch {
      toast.error("Export failed");
    } finally {
      clearUserActionPending();
    }
  };

  const params: Record<string, string> = { page: String(page), limit: "50" };
  if (search) params.search = search;
  if (provider) params.provider = provider;
  if (suspended) params.suspended = suspended;

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "users", params],
    queryFn: () => getAdminUsers(params)
  });

  const suspendMut = useMutation({
    mutationFn: (id: string) => suspendUser(id, "Suspended by admin"),
    onSuccess: () => {
      toast.success("User suspended");
      return qc.invalidateQueries({ queryKey: ["admin", "users"] });
    },
    onSettled: clearUserActionPending
  });

  const unsuspendMut = useMutation({
    mutationFn: (id: string) => unsuspendUser(id),
    onSuccess: () => {
      toast.success("User unsuspended");
      return qc.invalidateQueries({ queryKey: ["admin", "users"] });
    },
    onSettled: clearUserActionPending
  });

  const totalPages = data ? Math.ceil(data.total / data.limit) : 0;
  const rowActionPending = userActionPending || suspendMut.isPending || unsuspendMut.isPending;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Users</h1>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={rowActionPending}>
          <Download className="h-4 w-4 mr-1.5" />
          Export CSV
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 pt-4 pb-4">
          <div className="relative min-w-0 w-full sm:min-w-[200px] sm:flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by email or name..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="pl-9 h-9"
            />
          </div>
          <Select
            value={provider}
            onValueChange={(v) => {
              setProvider(v === "all" ? "" : v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-36 h-9">
              <SelectValue placeholder="Provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Providers</SelectItem>
              <SelectItem value="google">Google</SelectItem>
              <SelectItem value="github">GitHub</SelectItem>
              <SelectItem value="intuit">Intuit</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={suspended}
            onValueChange={(v) => {
              setSuspended(v === "all" ? "" : v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-36 h-9">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="false">Active</SelectItem>
              <SelectItem value="true">Suspended</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead className="hidden md:table-cell">Teams</TableHead>
                    <TableHead className="hidden md:table-cell">Jobs</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">Created</TableHead>
                    <TableHead className="w-24">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data?.users.map((user: AdminUser) => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <Link
                          to={`/admin/users/${user.id}`}
                          className="text-primary hover:underline font-medium truncate max-w-[200px] block"
                        >
                          {user.email}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{user.display_name}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {user.oauth_provider || "-"}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">{user.team_count}</TableCell>
                      <TableCell className="hidden md:table-cell">{user.job_count}</TableCell>
                      <TableCell>
                        {user.suspended_at ? (
                          <Badge variant="destructive" className="text-xs">
                            Suspended
                          </Badge>
                        ) : user.is_admin ? (
                          <Badge className="text-xs bg-purple-100 text-purple-800 hover:bg-purple-100">
                            <Shield className="h-3 w-3 mr-1" />
                            Admin
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs">
                            Active
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                        {new Date(user.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        {user.suspended_at ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            aria-label={`Unsuspend ${user.email}`}
                            onClick={() => runUserAction(() => unsuspendMut.mutate(user.id))}
                            disabled={rowActionPending}
                          >
                            Unsuspend
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs text-destructive"
                            aria-label={`Suspend ${user.email}`}
                            onClick={() => runUserAction(() => suspendMut.mutate(user.id))}
                            disabled={rowActionPending}
                          >
                            <Ban className="h-3 w-3 mr-1" />
                            Suspend
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {data?.users.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                        No users found
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{data?.total} users total</p>
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

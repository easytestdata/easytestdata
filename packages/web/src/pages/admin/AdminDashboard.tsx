import { useQuery } from "@tanstack/react-query";
import {
  Users,
  Building2,
  Briefcase,
  AlertTriangle,
  Zap,
  Plug,
  TrendingUp,
  BarChart3
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, Skeleton } from "@easytestdata/ui";
import { AdminKPICard } from "@/components/admin/AdminKPICard";
import { getAdminDashboard, getAdminTrends, getConversionFunnel } from "@/api/admin";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  BarChart,
  Bar,
  CartesianGrid
} from "recharts";

export function AdminDashboard() {
  const { data: kpis, isLoading } = useQuery({
    queryKey: ["admin", "dashboard"],
    queryFn: getAdminDashboard,
    refetchInterval: 30000
  });

  const { data: signupTrends } = useQuery({
    queryKey: ["admin", "trends", "signups"],
    queryFn: () => getAdminTrends("signups", "daily", 30)
  });

  const { data: funnel } = useQuery({
    queryKey: ["admin", "conversion-funnel"],
    queryFn: getConversionFunnel
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Overview</h1>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </div>
    );
  }

  const funnelData = funnel
    ? [
        { name: "Signups", value: funnel.signups },
        { name: "Connected QBO", value: funnel.connected },
        { name: "First Job", value: funnel.first_job }
      ]
    : [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Overview</h1>

      {/* KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <AdminKPICard icon={Users} label="Total Users" value={kpis?.totalUsers ?? 0} />
        <AdminKPICard icon={TrendingUp} label="New Users (7d)" value={kpis?.newUsers7d ?? 0} />
        <AdminKPICard icon={Building2} label="Total Teams" value={kpis?.totalTeams ?? 0} />
        <AdminKPICard icon={Briefcase} label="Jobs Today" value={kpis?.jobsToday ?? 0} />
        <AdminKPICard icon={Zap} label="Active Jobs" value={kpis?.activeJobs ?? 0} />
        <AdminKPICard
          icon={AlertTriangle}
          label="Failed (24h)"
          value={kpis?.failedJobs24h ?? 0}
          className={kpis?.failedJobs24h ? "border-red-200" : ""}
        />
        <AdminKPICard
          icon={BarChart3}
          label="Total Records"
          value={(kpis?.totalEntities ?? 0).toLocaleString()}
        />
        <AdminKPICard icon={Plug} label="Connections" value={kpis?.activeConnections ?? 0} />
      </div>

      {/* Signups over time */}
      <div>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Signups (30d)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-52">
              {signupTrends && signupTrends.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={signupTrends}>
                    <defs>
                      <linearGradient id="signupGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="date"
                      tickFormatter={(v) =>
                        new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                      }
                      tick={{ fontSize: 11 }}
                    />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip
                      labelFormatter={(v) => new Date(String(v)).toLocaleDateString()}
                      contentStyle={{ fontSize: 12 }}
                    />
                    <Area
                      type="monotone"
                      dataKey="count"
                      stroke="#3b82f6"
                      fill="url(#signupGrad)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  No signup data yet
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Conversion funnel */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Conversion Funnel</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-48">
            {funnelData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={funnelData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                  <YAxis dataKey="name" type="category" tick={{ fontSize: 12 }} width={120} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Bar dataKey="value" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                No funnel data yet
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Server health */}
      {kpis?.system && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Server</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <HealthRow label="Database" value={kpis.system.database} />
              <HealthRow label="Uptime" value={formatUptime(kpis.system.uptimeSeconds)} />
              <HealthRow label="Node.js" value={kpis.system.nodeVersion} />
              <HealthRow
                label="Memory (RSS / heap)"
                value={`${kpis.system.memoryMb.rss} MB / ${kpis.system.memoryMb.heapUsed} MB`}
              />
              <HealthRow
                label="Jobs by status"
                value={
                  Object.entries(kpis.system.jobsByStatus)
                    .map(([status, count]) => `${status} ${count}`)
                    .join(", ") || "none"
                }
              />
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function HealthRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

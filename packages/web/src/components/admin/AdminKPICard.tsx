import { type LucideIcon } from "lucide-react";
import { Card, CardContent, cn } from "@easytestdata/ui";
import { TrendingUp, TrendingDown } from "lucide-react";

interface AdminKPICardProps {
  icon: LucideIcon;
  label: string;
  value: string | number;
  trend?: { value: number; label: string };
  className?: string;
}

export function AdminKPICard({ icon: Icon, label, value, trend, className }: AdminKPICardProps) {
  return (
    <Card className={cn("transition-shadow hover:shadow-md", className)}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10">
            <Icon className="h-4.5 w-4.5 text-primary" />
          </div>
          {trend && (
            <div
              className={cn(
                "flex items-center gap-0.5 text-xs font-medium",
                trend.value >= 0 ? "text-green-600" : "text-red-600"
              )}
            >
              {trend.value >= 0 ? (
                <TrendingUp className="h-3 w-3" />
              ) : (
                <TrendingDown className="h-3 w-3" />
              )}
              {Math.abs(trend.value)}%
            </div>
          )}
        </div>
        <div className="mt-3">
          <p className="text-2xl font-bold tabular-nums">{value}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

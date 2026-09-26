import { cn } from "../../lib/utils";
import { Skeleton } from "../ui/skeleton";
import { Badge } from "../ui/badge";
import {
  Zap,
  Sprout,
  Rocket,
  Building,
  HeartPulse,
  Droplets,
  CalendarRange,
  ShieldAlert,
  BarChart3,
  type LucideIcon
} from "lucide-react";
import type { ScenarioPreset } from "../../types";

/** Keyed by the scenario preset ids in @easytestdata/core (see CardIcons.test.tsx). */
export const PRESET_ICONS: Record<string, LucideIcon> = {
  "healthy-small": HeartPulse,
  "cash-crisis": Droplets,
  "rapid-growth": Rocket,
  seasonal: CalendarRange,
  "mature-stable": Building,
  "audit-nightmare": ShieldAlert,
  "new-company": Sprout,
  "quick-demo": Zap
};

/** The quick demo comes first so a hurried developer finds it; the default stays healthy-small. */
export const FIRST_SCENARIO_ID = "quick-demo";

export function orderScenarios<T extends { id: string }>(presets: T[]): T[] {
  return [...presets].sort((a, b) => {
    if (a.id === FIRST_SCENARIO_ID) return -1;
    if (b.id === FIRST_SCENARIO_ID) return 1;
    return 0;
  });
}

function formatRevenue(val: unknown): string {
  const num = Number(val);
  if (!num || isNaN(num)) return "";
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `$${Math.round(num / 1_000)}K`;
  return `$${num}`;
}

interface PresetCardsProps {
  selectedId: string;
  onSelect: (id: string) => void;
  presets: ScenarioPreset[];
  isLoading: boolean;
}

export function PresetCards({ selectedId, onSelect, presets, isLoading }: PresetCardsProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-32 rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground">Scenario</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {orderScenarios(presets ?? []).map((p) => {
          const Icon = PRESET_ICONS[p.id] || BarChart3;
          const isSelected = selectedId === p.id;
          const revenue = p.request?.totalRevenue as number | undefined;
          const customers = p.request?.customerCount as number | undefined;
          const employees = p.request?.employeeCount as number | undefined;

          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(p.id)}
              title={p.description}
              aria-pressed={isSelected}
              className={cn(
                "flex flex-col items-start gap-2 rounded-xl border-2 p-4 text-left transition-all hover:border-primary/50 hover:shadow-xs",
                isSelected
                  ? "border-primary bg-primary/5 ring-2 ring-primary ring-offset-2"
                  : "border-border bg-card"
              )}
            >
              <div className="flex items-center gap-2">
                <Icon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    isSelected ? "text-primary" : "text-muted-foreground"
                  )}
                />
                <span className="text-sm font-medium">{p.name}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {p.months ? (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                    {p.months} months
                  </Badge>
                ) : null}
                {revenue ? (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                    {formatRevenue(revenue)}
                  </Badge>
                ) : null}
                {customers ? (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                    {String(customers)} customers
                  </Badge>
                ) : null}
                {employees ? (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                    {String(employees)} employees
                  </Badge>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

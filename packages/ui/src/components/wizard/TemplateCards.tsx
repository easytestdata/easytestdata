import { cn } from "../../lib/utils";
import { Skeleton } from "../ui/skeleton";
import {
  Briefcase,
  Building2,
  Stethoscope,
  HeartHandshake,
  ShoppingCart,
  Hammer,
  Utensils,
  Cloud,
  Check,
  type LucideIcon
} from "lucide-react";
import type { IndustryTemplate } from "../../types";

/** Keyed by the industry template ids in @easytestdata/core (see CardIcons.test.tsx). */
export const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  "professional-services": Briefcase,
  saas: Cloud,
  restaurant: Utensils,
  construction: Hammer,
  retail: ShoppingCart,
  healthcare: Stethoscope,
  nonprofit: HeartHandshake,
  "real-estate": Building2
};

interface TemplateCardsProps {
  selectedId: string;
  onSelect: (id: string) => void;
  templates: IndustryTemplate[];
  isLoading: boolean;
}

export function TemplateCards({ selectedId, onSelect, templates, isLoading }: TemplateCardsProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground">Industry</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {templates?.map((t) => {
          const Icon = TEMPLATE_ICONS[t.id] || Briefcase;
          const isSelected = selectedId === t.id;

          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelect(t.id)}
              title={t.description}
              aria-pressed={isSelected}
              className={cn(
                "relative flex flex-col items-center gap-2 rounded-xl border-2 p-4 text-center transition-all",
                isSelected
                  ? "border-primary bg-primary/5"
                  : "border-border bg-card hover:border-primary/40 hover:bg-accent"
              )}
            >
              {isSelected && (
                <div className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary">
                  <Check className="h-3 w-3 text-primary-foreground" />
                </div>
              )}
              <div
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-lg transition-colors",
                  isSelected ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                )}
              >
                <Icon className="h-5 w-5" />
              </div>
              <span
                className={cn(
                  "text-sm font-medium",
                  isSelected ? "text-primary" : "text-foreground"
                )}
              >
                {t.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

import { type LucideIcon } from "lucide-react";
import { type ReactNode } from "react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  illustration?: ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action, illustration }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-16 text-center">
      {illustration ? (
        <div className="mb-2">{illustration}</div>
      ) : (
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
          <Icon className="h-7 w-7 text-muted-foreground" />
        </div>
      )}
      <h3 className="mt-4 text-lg font-semibold">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

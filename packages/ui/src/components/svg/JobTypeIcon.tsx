import { cn } from "../../lib/utils";

interface JobTypeIconProps {
  type: string;
  className?: string;
}

export function JobTypeIcon({ type, className }: JobTypeIconProps) {
  const size = cn("inline-block h-4 w-4 shrink-0", className);

  switch (type) {
    case "load":
      return (
        <svg viewBox="0 0 16 16" fill="none" className={size}>
          <rect x="3" y="4" width="10" height="9" rx="1.5" stroke="#3b82f6" strokeWidth="1.3" />
          <path d="M8 1 L8 7" stroke="#3b82f6" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M5.5 5 L8 7.5 L10.5 5" stroke="#3b82f6" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "generate":
      return (
        <svg viewBox="0 0 16 16" fill="none" className={size}>
          <path d="M8 2 L8 6" stroke="#06b6d4" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M6 4 L10 4" stroke="#06b6d4" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M12 6 L12 9" stroke="#06b6d4" strokeWidth="1.3" strokeLinecap="round" opacity="0.6" />
          <path d="M10.5 7.5 L13.5 7.5" stroke="#06b6d4" strokeWidth="1.3" strokeLinecap="round" opacity="0.6" />
          <path d="M4 10 L4 13" stroke="#06b6d4" strokeWidth="1.3" strokeLinecap="round" opacity="0.4" />
          <path d="M2.5 11.5 L5.5 11.5" stroke="#06b6d4" strokeWidth="1.3" strokeLinecap="round" opacity="0.4" />
        </svg>
      );
    case "purge":
      return (
        <svg viewBox="0 0 16 16" fill="none" className={size}>
          <path d="M3 4 L13 4" stroke="#64748b" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M6 4 L6 2.5 L10 2.5 L10 4" stroke="#64748b" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4.5 4 L5 13 L11 13 L11.5 4" stroke="#64748b" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M7 7 L7 10.5" stroke="#64748b" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M9 7 L9 10.5" stroke="#64748b" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case "export":
      return (
        <svg viewBox="0 0 16 16" fill="none" className={size}>
          <path d="M8 10 L8 3" stroke="#22c55e" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M5 6 L8 3 L11 6" stroke="#22c55e" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3 11 L3 13 L13 13 L13 11" stroke="#22c55e" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "rollback":
      return (
        <svg viewBox="0 0 16 16" fill="none" className={size}>
          <path d="M4 7 L2 5 L4 3" stroke="#f59e0b" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M2 5 L9 5 Q13 5 13 9 Q13 13 9 13 L6 13" stroke="#f59e0b" strokeWidth="1.3" strokeLinecap="round" fill="none" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 16 16" fill="none" className={size}>
          <circle cx="8" cy="8" r="5" stroke="#64748b" strokeWidth="1.3" />
          <circle cx="8" cy="8" r="1.5" fill="#64748b" />
        </svg>
      );
  }
}

/** A job's type as shown to users, named after the button that starts it. */
export function jobTypeLabel(job: { type: string; config?: unknown }): string {
  const config = job.config as Record<string, unknown> | null | undefined;
  switch (job.type) {
    case "load":
      return "Load";
    case "generate":
      return "Sample files";
    case "export":
      return "Export";
    case "purge":
      return config?.purgeMode === "all" ? "Erase all data" : "Remove test data";
    case "rollback":
      return "Roll back";
    default:
      return job.type;
  }
}

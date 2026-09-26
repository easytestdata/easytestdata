import { cn } from "../../lib/utils";

interface EmptyTeamSvgProps {
  className?: string;
}

export function EmptyTeamSvg({ className }: EmptyTeamSvgProps) {
  return (
    <svg
      viewBox="0 0 120 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("w-28", className)}
    >
      {/* Person 1 (left) */}
      <circle cx="34" cy="38" r="8" fill="#0f172a" stroke="#334155" strokeWidth="1.5" />
      <rect x="22" y="50" width="24" height="12" rx="6" fill="#0f172a" stroke="#334155" strokeWidth="1" />

      {/* Person 2 (center, slightly larger) */}
      <circle cx="60" cy="34" r="10" fill="#0f172a" stroke="#334155" strokeWidth="1.5" />
      <rect x="46" y="48" width="28" height="14" rx="7" fill="#0f172a" stroke="#334155" strokeWidth="1" />

      {/* Person 3 (right, ghost/dashed — the one to invite) */}
      <circle cx="86" cy="38" r="8" fill="#0f172a" stroke="#334155" strokeWidth="1.5" strokeDasharray="3 2" />
      <rect x="74" y="50" width="24" height="12" rx="6" fill="#0f172a" stroke="#334155" strokeWidth="1" strokeDasharray="3 2" />

      {/* Invite arrow */}
      <path d="M96 30 L106 30" stroke="url(#empty-team-grad)" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M102 26 L108 30 L102 34" stroke="url(#empty-team-grad)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="102" cy="30" r="8" fill="#3b82f6" opacity="0.08" />

      {/* Plus in dashed person */}
      <path d="M83 38 L89 38" stroke="#3b82f6" strokeWidth="1" strokeLinecap="round" opacity="0.5" />
      <path d="M86 35 L86 41" stroke="#3b82f6" strokeWidth="1" strokeLinecap="round" opacity="0.5" />

      <defs>
        <linearGradient id="empty-team-grad" x1="96" y1="26" x2="108" y2="34" gradientUnits="userSpaceOnUse">
          <stop stopColor="#3b82f6" />
          <stop offset="1" stopColor="#06b6d4" />
        </linearGradient>
      </defs>
    </svg>
  );
}

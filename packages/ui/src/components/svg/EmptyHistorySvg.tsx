import { cn } from "../../lib/utils";

interface EmptyHistorySvgProps {
  className?: string;
}

export function EmptyHistorySvg({ className }: EmptyHistorySvgProps) {
  return (
    <svg
      viewBox="0 0 120 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("w-28", className)}
    >
      {/* Timeline line */}
      <line x1="30" y1="12" x2="30" y2="88" stroke="#1e293b" strokeWidth="2" />

      {/* Empty timeline nodes */}
      <circle cx="30" cy="24" r="6" fill="#0f172a" stroke="#334155" strokeWidth="1.5" />
      <rect x="44" y="18" width="52" height="12" rx="4" fill="#0f172a" />
      <rect x="48" y="22" width="30" height="3" rx="1.5" fill="#334155" />

      <circle cx="30" cy="48" r="6" fill="#0f172a" stroke="#334155" strokeWidth="1.5" />
      <rect x="44" y="42" width="52" height="12" rx="4" fill="#0f172a" />
      <rect x="48" y="46" width="36" height="3" rx="1.5" fill="#334155" />

      <circle cx="30" cy="72" r="6" fill="#0f172a" stroke="#334155" strokeWidth="1.5" />
      <rect x="44" y="66" width="52" height="12" rx="4" fill="#0f172a" />
      <rect x="48" y="70" width="24" height="3" rx="1.5" fill="#334155" />

      {/* Sparkle "+" suggesting first job */}
      <path d="M100 16 L100 28" stroke="url(#empty-hist-grad)" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M94 22 L106 22" stroke="url(#empty-hist-grad)" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="100" cy="22" r="8" fill="#3b82f6" opacity="0.08" />

      <defs>
        <linearGradient id="empty-hist-grad" x1="94" y1="16" x2="106" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#3b82f6" />
          <stop offset="1" stopColor="#06b6d4" />
        </linearGradient>
      </defs>
    </svg>
  );
}

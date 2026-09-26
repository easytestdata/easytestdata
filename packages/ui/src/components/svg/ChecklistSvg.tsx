import { cn } from "../../lib/utils";

interface ChecklistSvgProps {
  className?: string;
}

export function ChecklistSvg({ className }: ChecklistSvgProps) {
  return (
    <svg
      viewBox="0 0 200 80"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("w-48", className)}
    >
      {/* Background card */}
      <rect x="10" y="4" width="180" height="72" rx="8" fill="#0f172a" />

      {/* Row 1 - Industry */}
      <rect x="22" y="12" width="156" height="16" rx="4" fill="#1e293b" />
      <circle cx="34" cy="20" r="5" fill="#22c55e" opacity="0.2" />
      <path d="M31 20 L33 22 L37 18" stroke="#22c55e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="44" y="17" width="40" height="3" rx="1.5" fill="#3b82f6" opacity="0.7" />
      <rect x="44" y="22" width="28" height="2" rx="1" fill="#475569" />

      {/* Row 2 - Config */}
      <rect x="22" y="32" width="156" height="16" rx="4" fill="#1e293b" />
      <circle cx="34" cy="40" r="5" fill="#22c55e" opacity="0.2" />
      <path d="M31 40 L33 42 L37 38" stroke="#22c55e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="44" y="37" width="36" height="3" rx="1.5" fill="#3b82f6" opacity="0.7" />
      <rect x="44" y="42" width="50" height="2" rx="1" fill="#475569" />

      {/* Row 3 - Connection */}
      <rect x="22" y="52" width="156" height="16" rx="4" fill="#1e293b" />
      <circle cx="34" cy="60" r="5" fill="#22c55e" opacity="0.2" />
      <path d="M31 60 L33 62 L37 58" stroke="#22c55e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="44" y="57" width="44" height="3" rx="1.5" fill="#3b82f6" opacity="0.7" />
      <rect x="44" y="62" width="32" height="2" rx="1" fill="#475569" />

      {/* Ready badge */}
      <rect x="140" y="34" width="32" height="12" rx="6" fill="#22c55e" opacity="0.15" />
      <text x="156" y="43" textAnchor="middle" fill="#22c55e" fontSize="6" fontWeight="600">Ready</text>
    </svg>
  );
}

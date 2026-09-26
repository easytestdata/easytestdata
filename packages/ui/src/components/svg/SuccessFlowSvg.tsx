import { cn } from "../../lib/utils";

interface SuccessFlowSvgProps {
  className?: string;
}

export function SuccessFlowSvg({ className }: SuccessFlowSvgProps) {
  return (
    <svg
      viewBox="0 0 200 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("w-40", className)}
    >
      {/* Data items flowing in */}
      <rect x="8" y="20" width="28" height="10" rx="3" fill="#059669" opacity="0.3" />
      <rect x="12" y="24" width="14" height="3" rx="1.5" fill="#10b981" />

      <rect x="8" y="36" width="28" height="10" rx="3" fill="#059669" opacity="0.3" />
      <rect x="12" y="40" width="18" height="3" rx="1.5" fill="#10b981" />

      <rect x="8" y="52" width="28" height="10" rx="3" fill="#059669" opacity="0.3" />
      <rect x="12" y="56" width="12" height="3" rx="1.5" fill="#10b981" />

      <rect x="8" y="68" width="28" height="10" rx="3" fill="#059669" opacity="0.3" />
      <rect x="12" y="72" width="16" height="3" rx="1.5" fill="#10b981" />

      {/* Flow arrows */}
      <path d="M42 26 L62 44" stroke="#10b981" strokeWidth="1" strokeDasharray="3 2" opacity="0.5" />
      <path d="M42 42 L62 46" stroke="#10b981" strokeWidth="1" strokeDasharray="3 2" opacity="0.5" />
      <path d="M42 58 L62 50" stroke="#10b981" strokeWidth="1" strokeDasharray="3 2" opacity="0.5" />
      <path d="M42 74 L62 52" stroke="#10b981" strokeWidth="1" strokeDasharray="3 2" opacity="0.5" />

      {/* Central checkmark circle */}
      <circle cx="80" cy="48" r="18" fill="url(#success-circle-grad)" opacity="0.15" />
      <circle cx="80" cy="48" r="13" fill="url(#success-circle-grad)" opacity="0.3" />
      <path d="M72 48 L77 53 L88 42" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

      {/* Arrow to QBO doc */}
      <path d="M98 48 L120 48" stroke="#10b981" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.5" />
      <path d="M116 44 L122 48 L116 52" stroke="#10b981" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.5" />

      {/* QBO document icon */}
      <rect x="126" y="28" width="48" height="40" rx="4" fill="#0f172a" stroke="#10b981" strokeWidth="1" opacity="0.8" />
      <path d="M126 28 L158 28 L174 44" stroke="#10b981" strokeWidth="1" opacity="0.3" />
      <rect x="134" y="40" width="28" height="2.5" rx="1" fill="#10b981" opacity="0.4" />
      <rect x="134" y="46" width="22" height="2.5" rx="1" fill="#10b981" opacity="0.3" />
      <rect x="134" y="52" width="26" height="2.5" rx="1" fill="#10b981" opacity="0.4" />
      <rect x="134" y="58" width="18" height="2.5" rx="1" fill="#10b981" opacity="0.3" />

      {/* Sparkles */}
      <circle cx="170" cy="30" r="2" fill="#10b981" opacity="0.4" />
      <circle cx="180" cy="40" r="1.5" fill="#06b6d4" opacity="0.3" />
      <circle cx="186" cy="54" r="1" fill="#10b981" opacity="0.5" />

      <defs>
        <linearGradient id="success-circle-grad" x1="62" y1="30" x2="98" y2="66" gradientUnits="userSpaceOnUse">
          <stop stopColor="#10b981" />
          <stop offset="1" stopColor="#14b8a6" />
        </linearGradient>
      </defs>
    </svg>
  );
}

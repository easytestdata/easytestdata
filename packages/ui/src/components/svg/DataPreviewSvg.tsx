import { cn } from "../../lib/utils";

interface DataPreviewSvgProps {
  className?: string;
}

export function DataPreviewSvg({ className }: DataPreviewSvgProps) {
  return (
    <svg
      viewBox="0 0 280 180"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("w-64", className)}
    >
      {/* Browser window frame */}
      <rect x="10" y="10" width="260" height="160" rx="8" fill="#1e293b" stroke="#334155" strokeWidth="1" />
      {/* Title bar */}
      <rect x="10" y="10" width="260" height="24" rx="8" fill="#0f172a" />
      <rect x="10" y="26" width="260" height="8" fill="#0f172a" />
      {/* Window dots */}
      <circle cx="26" cy="22" r="3" fill="#ef4444" opacity="0.7" />
      <circle cx="38" cy="22" r="3" fill="#eab308" opacity="0.7" />
      <circle cx="50" cy="22" r="3" fill="#22c55e" opacity="0.7" />

      {/* Data rows with gradient accents */}
      <rect x="24" y="46" width="232" height="22" rx="4" fill="#0f172a" />
      <rect x="28" y="50" width="60" height="4" rx="2" fill="#3b82f6" opacity="0.8" />
      <rect x="28" y="58" width="40" height="3" rx="1.5" fill="#475569" />
      <rect x="200" y="52" width="48" height="8" rx="4" fill="#06b6d4" opacity="0.3" />
      <rect x="204" y="54" width="28" height="4" rx="2" fill="#06b6d4" />

      <rect x="24" y="74" width="232" height="22" rx="4" fill="#0f172a" />
      <rect x="28" y="78" width="52" height="4" rx="2" fill="#3b82f6" opacity="0.8" />
      <rect x="28" y="86" width="36" height="3" rx="1.5" fill="#475569" />
      <rect x="200" y="80" width="48" height="8" rx="4" fill="#22c55e" opacity="0.3" />
      <rect x="204" y="82" width="32" height="4" rx="2" fill="#22c55e" />

      <rect x="24" y="102" width="232" height="22" rx="4" fill="#0f172a" />
      <rect x="28" y="106" width="48" height="4" rx="2" fill="#3b82f6" opacity="0.8" />
      <rect x="28" y="114" width="44" height="3" rx="1.5" fill="#475569" />
      <rect x="200" y="108" width="48" height="8" rx="4" fill="#06b6d4" opacity="0.3" />
      <rect x="204" y="110" width="24" height="4" rx="2" fill="#06b6d4" />

      <rect x="24" y="130" width="232" height="22" rx="4" fill="#0f172a" />
      <rect x="28" y="134" width="56" height="4" rx="2" fill="#3b82f6" opacity="0.8" />
      <rect x="28" y="142" width="32" height="3" rx="1.5" fill="#475569" />
      <rect x="200" y="136" width="48" height="8" rx="4" fill="#8b5cf6" opacity="0.3" />
      <rect x="204" y="138" width="36" height="4" rx="2" fill="#8b5cf6" />

      {/* Decorative sparkle */}
      <circle cx="252" cy="22" r="2" fill="#06b6d4" opacity="0.6" />
    </svg>
  );
}

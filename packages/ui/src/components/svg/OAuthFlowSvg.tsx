import { cn } from "../../lib/utils";

interface OAuthFlowSvgProps {
  className?: string;
}

export function OAuthFlowSvg({ className }: OAuthFlowSvgProps) {
  return (
    <svg
      viewBox="0 0 200 140"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("w-48", className)}
    >
      {/* Browser window */}
      <rect x="20" y="10" width="160" height="110" rx="8" fill="#1e293b" stroke="#334155" strokeWidth="1" />
      <rect x="20" y="10" width="160" height="20" rx="8" fill="#0f172a" />
      <rect x="20" y="22" width="160" height="8" fill="#0f172a" />
      <circle cx="34" cy="20" r="2.5" fill="#ef4444" opacity="0.7" />
      <circle cx="44" cy="20" r="2.5" fill="#eab308" opacity="0.7" />
      <circle cx="54" cy="20" r="2.5" fill="#22c55e" opacity="0.7" />

      {/* Shield icon in center */}
      <path
        d="M100 48 L116 56 L116 72 Q116 84 100 92 Q84 84 84 72 L84 56 Z"
        fill="url(#oauth-shield-grad)"
        opacity="0.9"
      />
      {/* Checkmark inside shield */}
      <path
        d="M93 70 L98 75 L108 63"
        stroke="white"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      {/* Connection lines */}
      <line x1="40" y1="70" x2="80" y2="70" stroke="#3b82f6" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.5" />
      <line x1="120" y1="70" x2="160" y2="70" stroke="#06b6d4" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.5" />

      {/* Left icon - user */}
      <circle cx="40" cy="64" r="4" fill="#3b82f6" opacity="0.6" />
      <rect x="34" y="70" width="12" height="6" rx="3" fill="#3b82f6" opacity="0.4" />

      {/* Right icon - QBO */}
      <rect x="150" y="62" width="16" height="16" rx="3" fill="#06b6d4" opacity="0.4" />
      <text x="158" y="74" textAnchor="middle" fill="#06b6d4" fontSize="8" fontWeight="bold">Q</text>

      {/* Connect button at bottom */}
      <rect x="60" y="98" width="80" height="14" rx="7" fill="url(#oauth-btn-grad)" />
      <text x="100" y="108" textAnchor="middle" fill="white" fontSize="7" fontWeight="600">Connect QBO</text>

      <defs>
        <linearGradient id="oauth-shield-grad" x1="84" y1="48" x2="116" y2="92" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2563eb" />
          <stop offset="1" stopColor="#06b6d4" />
        </linearGradient>
        <linearGradient id="oauth-btn-grad" x1="60" y1="98" x2="140" y2="112" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2563eb" />
          <stop offset="1" stopColor="#06b6d4" />
        </linearGradient>
      </defs>
    </svg>
  );
}

import { cn } from "../../lib/utils";

interface BrandLogoProps {
  className?: string;
}

export function BrandLogo({ className }: BrandLogoProps) {
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("h-10 w-10", className)}
    >
      <defs>
        <linearGradient id="brand-grad" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2563eb" />
          <stop offset="1" stopColor="#06b6d4" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="10" fill="url(#brand-grad)" />
      {/* Stylized "E" formed from horizontal bars */}
      <rect x="11" y="10" width="18" height="3.5" rx="1.5" fill="white" />
      <rect x="11" y="18.25" width="14" height="3.5" rx="1.5" fill="white" opacity="0.85" />
      <rect x="11" y="26.5" width="18" height="3.5" rx="1.5" fill="white" />
      {/* Vertical connector */}
      <rect x="11" y="10" width="3.5" height="20" rx="1.5" fill="white" />
    </svg>
  );
}

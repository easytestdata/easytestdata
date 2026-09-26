import { Shield, Lock, KeyRound, Tag } from "lucide-react";
import { cn } from "../lib/utils";

interface TrustBannerProps {
  variant?: "full" | "compact" | "badge";
  className?: string;
}

/** The open-source repository (Apache-2.0) the app links to. */
export const REPO_URL = "https://github.com/easytestdata/easytestdata";

/** The runtime guard that refuses any non-sandbox QuickBooks address; linked so users can read it. */
export const SANDBOX_GUARD_SOURCE_URL = `${REPO_URL}/blob/main/packages/qbo-client/src/qbo-client.js`;

function GuardLink() {
  return (
    <a
      href={SANDBOX_GUARD_SOURCE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2 hover:text-emerald-950"
      title="Search the file for assertSandboxBaseUrl"
    >
      see the check in the code
    </a>
  );
}

export function TrustBanner({ variant = "full", className }: TrustBannerProps) {
  if (variant === "badge") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700",
          className
        )}
      >
        <Shield className="h-3 w-3" />
        Sandbox only
      </span>
    );
  }

  if (variant === "compact") {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800",
          className
        )}
      >
        <Shield className="h-4 w-4 text-emerald-600" />
        <span>
          <strong>Sandbox companies only.</strong> EasyTestData refuses any non-sandbox QuickBooks
          address &mdash; <GuardLink />.
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-teal-50 p-5",
        className
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
          <Shield className="h-5 w-5 text-emerald-600" />
        </div>
        <div className="space-y-2">
          <h3 className="font-semibold text-emerald-900">Sandbox companies only</h3>
          <ul className="space-y-1.5 text-sm text-emerald-800">
            <li className="flex items-start gap-2">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
              <span>
                EasyTestData refuses any non-sandbox QuickBooks address &mdash; <GuardLink />.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
              <span>Intuit development keys can only connect sandbox companies.</span>
            </li>
            <li className="flex items-start gap-2">
              <Tag className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
              <span>Every generated record is tagged so you can clear it later.</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

import { ExternalLink } from "lucide-react";
import { cn } from "../../lib/utils";
import { formatDateRange } from "../../lib/format";

/** QuickBooks Online's sandbox UI (the only kind of company EasyTestData can load). */
export const QBO_SANDBOX_APP_URL = "https://app.sandbox.qbo.intuit.com/app/homepage";

interface SandboxNextStepsProps {
  companyName?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  className?: string;
}

/** "Open your sandbox" link plus where to look first, shown after a load completes. */
export function SandboxNextSteps({
  companyName,
  startDate,
  endDate,
  className
}: SandboxNextStepsProps) {
  const period = startDate || endDate ? formatDateRange(startDate, endDate) : null;
  const pointers = [
    "Sales > Invoices for customers, invoices and payments",
    "Expenses > Bills for vendors and bills",
    `Reports > Profit and Loss${period ? ` for ${period}` : " for the loaded period"}`
  ];

  return (
    <div className={cn("space-y-3 text-left text-sm", className)}>
      <a
        href={QBO_SANDBOX_APP_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
      >
        <ExternalLink className="h-4 w-4" />
        Open your sandbox in QuickBooks
      </a>
      <p className="text-xs text-muted-foreground">
        If you have several sandboxes, switch to{" "}
        {companyName ? <strong>{companyName}</strong> : "the connected company"} in QuickBooks
        first.
      </p>
      <div>
        <p className="font-medium">What to look at</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
          {pointers.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatNumber } from "../../lib/format";

interface JobDataViewerProps {
  data: Record<string, unknown> | undefined;
  isLoading: boolean;
  error?: Error | null;
}

const ENTITY_LABELS: Record<string, string> = {
  customers: "Customers",
  vendors: "Vendors",
  employees: "Employees",
  invoices: "Invoices",
  bills: "Bills",
  salesReceipts: "Sales Receipts",
  payments: "Payments",
  billPayments: "Bill Payments",
  estimates: "Estimates",
  purchaseOrders: "Purchase Orders",
  creditMemos: "Credit Memos",
  refundReceipts: "Refund Receipts",
  vendorCredits: "Vendor Credits",
  deposits: "Deposits",
  transfers: "Transfers",
  journalEntries: "Journal Entries",
  payroll: "Payroll",
  directExpenses: "Direct Expenses"
};

const DISPLAY_ORDER = Object.keys(ENTITY_LABELS);

function formatValue(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "number") return formatNumber(val);
  if (Array.isArray(val)) return val.length > 0 ? `[${val.length} items]` : "[]";
  if (typeof val === "object") {
    // Nested records such as addresses read better as "681 Oak Ave, Nashville, TN, 37203"
    return Object.values(val as Record<string, unknown>)
      .filter((v) => v != null && v !== "" && typeof v !== "object")
      .join(", ");
  }
  return String(val);
}

function getColumns(items: unknown[]): string[] {
  if (items.length === 0) return [];
  const first = items[0];
  if (typeof first === "string") return ["name"];
  if (typeof first === "object" && first !== null) {
    return Object.keys(first).filter((k) => k !== "lines" && k !== "lineItems");
  }
  return ["value"];
}

function getCellValue(item: unknown, col: string): string {
  if (typeof item === "string") return item;
  if (typeof item === "object" && item !== null) {
    return formatValue((item as Record<string, unknown>)[col]);
  }
  return String(item ?? "");
}

function formatColumnHeader(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

function EntitySection({ name, items }: { name: string; items: unknown[] }) {
  const [expanded, setExpanded] = useState(false);
  const label = ENTITY_LABELS[name] || name;
  const columns = getColumns(items);

  return (
    <div className="border rounded-md">
      <button
        className="flex items-center justify-between w-full px-3 py-2 text-sm font-medium text-left hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          {label}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatNumber(items.length)}
        </span>
      </button>
      {expanded && (
        <div className="border-t overflow-x-auto max-h-64 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 sticky top-0">
              <tr>
                {columns.map((col) => (
                  <th
                    key={col}
                    className="px-2.5 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap"
                  >
                    {formatColumnHeader(col)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={i} className="border-t border-muted/50">
                  {columns.map((col) => (
                    <td key={col} className="px-2.5 py-1 whitespace-nowrap">
                      {getCellValue(item, col)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function JobDataViewer({ data, isLoading, error }: JobDataViewerProps) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        <h4 className="text-sm font-medium">Generated Data</h4>
        <div className="text-xs text-muted-foreground">Loading data...</div>
      </div>
    );
  }

  if (error || !data) return null;

  const sections = DISPLAY_ORDER.filter(
    (key) => Array.isArray(data[key]) && (data[key] as unknown[]).length > 0
  );

  if (sections.length === 0) return null;

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">Generated Data</h4>
      <div className="space-y-1">
        {sections.map((key) => (
          <EntitySection key={key} name={key} items={data[key] as unknown[]} />
        ))}
      </div>
    </div>
  );
}

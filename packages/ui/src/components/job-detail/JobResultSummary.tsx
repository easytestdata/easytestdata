import type { JobResultSummary as ResultSummary } from "../../types";
import { formatCurrency, formatNumber } from "../../lib/format";

interface JobResultSummaryProps {
  result: ResultSummary;
  type: string;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function EntityGrid({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([, v]) => v > 0);
  if (entries.length === 0) return null;
  return (
    <div className="space-y-2">
      <h5 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Records created
      </h5>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {entries.map(([key, count]) => (
          <div
            key={key}
            className="flex items-center justify-between rounded border px-2.5 py-1.5 text-sm"
          >
            <span className="capitalize text-muted-foreground">
              {key.replace(/([A-Z])/g, " $1").trim()}
            </span>
            <span className="font-medium tabular-nums">{formatNumber(count)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PurgeResult({ result }: { result: ResultSummary }) {
  const byEntity = result.deletedByEntity;
  const total = result.deletedTotal ?? result.totalDeleted ?? 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3">
        <StatCard label="Deleted" value={formatNumber(total)} />
      </div>
      {byEntity && Object.keys(byEntity).length > 0 && (
        <div className="space-y-2">
          <h5 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            By record type
          </h5>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {Object.entries(byEntity)
              .filter(([, v]) => v > 0)
              .map(([key, count]) => (
                <div
                  key={key}
                  className="flex items-center justify-between rounded border px-2.5 py-1.5 text-sm"
                >
                  <span className="capitalize text-muted-foreground">
                    {key.replace(/([A-Z])/g, " $1").trim()}
                  </span>
                  <span className="font-medium tabular-nums">{formatNumber(count)}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function GenerateLoadResult({ result }: { result: ResultSummary }) {
  const m = result.metrics;
  const counts = result.counts;
  // Load and download results carry core's plan metrics (`...Generated`).
  const revenue = m?.totalRevenueGenerated ?? m?.revenue;
  const expenses = m?.totalExpensesGenerated ?? m?.expenses;
  const profit = m?.ebitdaGenerated ?? m?.ebitda;

  return (
    <div className="space-y-4">
      {m && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {revenue != null && <StatCard label="Revenue" value={formatCurrency(revenue)} />}
          {expenses != null && <StatCard label="Expenses" value={formatCurrency(expenses)} />}
          {profit != null && <StatCard label="Profit" value={formatCurrency(profit)} />}
          {m.netIncome != null && (
            <StatCard label="Net income" value={formatCurrency(m.netIncome)} />
          )}
        </div>
      )}
      {counts && <EntityGrid counts={counts} />}
    </div>
  );
}

function RollbackResult({ result }: { result: ResultSummary }) {
  // Deleted transactions plus master data made inactive.
  const total = (result.totalDeleted ?? result.deletedTotal ?? 0) + (result.totalInactivated ?? 0);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3">
        <StatCard label="Rolled back" value={formatNumber(total)} />
      </div>
      {result.note && <p className="text-sm text-muted-foreground">{result.note}</p>}
    </div>
  );
}

export function JobResultSummaryView({ result, type }: JobResultSummaryProps) {
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">Results</h4>
      {type === "purge" ? (
        <PurgeResult result={result} />
      ) : type === "rollback" ? (
        <RollbackResult result={result} />
      ) : (
        <GenerateLoadResult result={result} />
      )}
    </div>
  );
}

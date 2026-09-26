import { useState } from "react";
import { TemplateCards } from "./TemplateCards";
import { PresetCards } from "./PresetCards";
import { QuickCustomize } from "./QuickCustomize";
import { InlineJobProgress } from "./InlineJobProgress";
import { AdvancedFields } from "../scenario-config/AdvancedFields";
import { Button } from "../ui/button";
import { formatDateRange, formatNumber, formatTemplateName } from "../../lib/format";
import { cn } from "../../lib/utils";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  Download,
  Info,
  Loader2,
  Rocket,
  SlidersHorizontal
} from "lucide-react";
import type {
  ConnectionHealth,
  IndustryTemplate,
  Job,
  LoadEstimate,
  QboConnection,
  ScenarioPreset
} from "../../types";
import type { ScenarioFormState } from "../scenario-config/useScenarioForm";

/**
 * Rough sustained write rate into a QuickBooks sandbox: batches of 30 records, two in flight,
 * a few seconds per batch, under Intuit's 500 requests/minute limit. Used only for the
 * "about N minutes" hint; the job reports real progress once it runs.
 */
export const RECORDS_PER_MINUTE = 300;

const SUMMARY_COUNTS: Array<[string, string]> = [
  ["customerCount", "customers"],
  ["invoiceCount", "invoices"],
  ["billCount", "bills"],
  ["paymentCount", "payments"],
  ["employeeCount", "employees"]
];

export interface EstimateSummary {
  /** e.g. "~800 records" */
  headline: string;
  /** e.g. "20 customers, 240 invoices, 48 bills, 176 payments" */
  detail: string;
  /** e.g. "about 3 minutes at QuickBooks' rate limit"; undefined for downloads */
  duration?: string;
  overLimit: boolean;
}

export function describeDuration(records: number): string {
  const minutes = Math.ceil(records / RECORDS_PER_MINUTE);
  if (records < RECORDS_PER_MINUTE / 2) return "under a minute";
  return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function summarizeEstimate(
  estimate: LoadEstimate,
  { generateOnly = false }: { generateOnly?: boolean } = {}
): EstimateSummary {
  const metrics = estimate.metrics ?? {};
  const detail = SUMMARY_COUNTS.filter(([key]) => (metrics[key] ?? 0) > 0)
    .map(([key, label]) => `${formatNumber(metrics[key])} ${label}`)
    .join(", ");
  return {
    headline: `~${formatNumber(estimate.estimatedEntities)} records`,
    detail,
    duration: generateOnly
      ? undefined
      : `${describeDuration(estimate.estimatedEntities)} at QuickBooks' rate limit`,
    overLimit: estimate.limit !== -1 && estimate.estimatedEntities > estimate.limit
  };
}

interface LoadStepProps {
  form: ScenarioFormState;
  setField: <K extends keyof ScenarioFormState>(key: K, value: ScenarioFormState[K]) => void;
  setRatio: (key: string, value: string) => void;
  applyPreset: (id: string) => void;
  overrideCount: number;
  advancedOpen: boolean;
  setAdvancedOpen: (open: boolean) => void;
  connections: QboConnection[];
  templates: IndustryTemplate[];
  isLoadingTemplates: boolean;
  presets: ScenarioPreset[];
  isLoadingPresets: boolean;
  estimate: LoadEstimate | null;
  isEstimating?: boolean;
  /** The last estimate request failed; loading is still allowed (the server re-checks limits). */
  estimateFailed?: boolean;
  /** This connection already holds an earlier EasyTestData load (offers to clear it first). */
  hasPreviousLoad?: boolean;
  connectionHealth?: ConnectionHealth;
  activeJob: Job | null;
  onJobUpdate?: () => void;
  onLoadMore?: () => void;
  onCancelJob: (jobId: string) => Promise<void>;
  onRollback?: (jobId: string) => Promise<void>;
  onViewDetails?: (job: Job) => void;
  isLoading: boolean;
  /** No sandbox: generate a downloadable file instead of loading into QuickBooks. */
  generateOnly?: boolean;
  onLoad: () => void;
  onGenerate?: () => void;
  onBack?: () => void;
}

/**
 * The whole "load a company" decision on one screen: industry cards (Professional Services
 * preselected), the default scenario and period, a summary of what will be created, and one
 * primary button. Everything else lives behind "Customize".
 */
export function LoadStep({
  form,
  setField,
  setRatio,
  applyPreset,
  overrideCount,
  advancedOpen,
  setAdvancedOpen,
  connections,
  templates,
  isLoadingTemplates,
  presets,
  isLoadingPresets,
  estimate,
  isEstimating = false,
  estimateFailed = false,
  hasPreviousLoad = false,
  connectionHealth,
  activeJob,
  onJobUpdate,
  onLoadMore,
  onCancelJob,
  onRollback,
  onViewDetails,
  isLoading,
  generateOnly = false,
  onLoad,
  onGenerate,
  onBack
}: LoadStepProps) {
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const connection = connections.find((c) => c.id === form.connectionId);
  const connectionName = connection?.company_name || "your QuickBooks sandbox";

  if (activeJob) {
    // A roll back or re-run started from Recent activity can target another sandbox than the
    // selected one: name the job's own.
    const jobConnectionId =
      activeJob.connection_id ?? (activeJob.config?.connectionId as string | undefined);
    const jobConnectionName = jobConnectionId
      ? connections.find((c) => c.id === jobConnectionId)?.company_name
      : connection?.company_name;
    return (
      // Keyed by job: a roll back replacing its stopped load gets a fresh card (status, log).
      <InlineJobProgress
        key={activeJob.id}
        job={activeJob}
        onJobUpdate={onJobUpdate}
        onLoadMore={onLoadMore}
        connectionName={jobConnectionName}
        onCancelJob={onCancelJob}
        onRollback={onRollback}
        onViewDetails={onViewDetails}
      />
    );
  }

  const scenario = presets.find((p) => p.id === form.presetId);
  const scenarioName = scenario?.name || (form.presetId ? formatTemplateName(form.presetId) : "");
  const summary = estimate ? summarizeEstimate(estimate, { generateOnly }) : null;
  // The numbers shown belong to an earlier choice while a new estimate is in flight.
  const summaryStale = Boolean(summary && isEstimating);
  const health = connectionHealth;
  const expired =
    !generateOnly && (health?.status === "expired" || connection?.tokenHealth === "expired");
  const clearFirst = form.purgeMode === "generated";
  const periodChosen = Boolean(form.templateId && form.startDate && form.endDate);
  // Never launch from a stale summary (its over-limit check may be wrong); a failed estimate
  // does not block, the server applies the limits again when the job is created.
  const launchBlocked = isLoading || isEstimating || !periodChosen || summary?.overLimit;

  return (
    <div className="space-y-6">
      <TemplateCards
        selectedId={form.templateId}
        onSelect={(id) => setField("templateId", id)}
        templates={templates}
        isLoading={isLoadingTemplates}
      />

      {/* What you get */}
      <div className="rounded-xl border bg-card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{scenarioName || "Scenario"}</span>
            {form.startDate && form.endDate && (
              <> &middot; {formatDateRange(form.startDate, form.endDate)}</>
            )}
            {!generateOnly && (
              <>
                {" "}
                &middot; into <span className="font-medium text-foreground">{connectionName}</span>
              </>
            )}
          </p>
        </div>
        <div className="mt-2 text-sm" aria-live="polite" aria-busy={isEstimating}>
          {summary && (
            <div className={cn(summaryStale && "opacity-50")}>
              <p className="font-medium">
                {summary.headline}
                {summary.detail && (
                  <span className="font-normal text-muted-foreground">: {summary.detail}</span>
                )}
              </p>
              {summary.duration && (
                <p className="mt-0.5 text-muted-foreground">{summary.duration}</p>
              )}
              {summary.overLimit && !summaryStale && (
                <p className="mt-2 flex items-center gap-2 text-destructive">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  That is more than the {formatNumber(estimate?.limit)} records allowed per job.
                  Choose a smaller scenario or fewer months, or run EasyTestData locally for no
                  limits.
                </p>
              )}
            </div>
          )}
          {isEstimating && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {summary ? "Updating the estimate..." : "Working out what will be created..."}
            </p>
          )}
          {!isEstimating && !summary && estimateFailed && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              Couldn&apos;t work out what will be created. You can still{" "}
              {generateOnly ? "generate" : "load"} it; the limits are checked when the job starts.
            </p>
          )}
          {!isEstimating && !summary && !estimateFailed && <p> </p>}
        </div>

        <button
          type="button"
          onClick={() => setCustomizeOpen(!customizeOpen)}
          aria-expanded={customizeOpen}
          className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
        >
          <SlidersHorizontal className="h-4 w-4" />
          Customize
          <ChevronDown
            className={cn("h-4 w-4 transition-transform", customizeOpen && "rotate-180")}
          />
        </button>

        {customizeOpen && (
          <div className="mt-4 space-y-5 border-t pt-4">
            <PresetCards
              selectedId={form.presetId}
              onSelect={applyPreset}
              presets={presets}
              isLoading={isLoadingPresets}
            />
            <QuickCustomize form={form} setField={setField} connections={connections} />
            <AdvancedFields
              ratioOverrides={form.ratioOverrides}
              setRatio={setRatio}
              overrideCount={overrideCount}
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
            />
          </div>
        )}
      </div>

      {expired && (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
          <div>
            <p className="font-medium">QuickBooks connection expired</p>
            <p className="mt-0.5 text-red-800/80">
              {health?.warnings?.[0] || "Reconnect your sandbox before loading data."}
            </p>
          </div>
        </div>
      )}
      {!generateOnly && health?.status === "warning" && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p>{health.warnings?.[0]}</p>
        </div>
      )}

      {!generateOnly && (
        <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
          <div className="flex-1 space-y-2">
            <p>
              Loading adds to what is already in the sandbox. Every record is tagged{" "}
              <code className="rounded bg-blue-100 px-1">EZTD</code>, so you can remove it later with
              Remove test data.
            </p>
            {hasPreviousLoad && (
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={clearFirst}
                  onChange={(e) => setField("purgeMode", e.target.checked ? "generated" : "none")}
                  className="h-4 w-4 rounded border-blue-300 text-blue-600 focus:ring-blue-500"
                />
                <span>Remove existing test data (tagged EZTD) first</span>
              </label>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        {onBack ? (
          <Button variant="ghost" onClick={onBack}>
            <ChevronLeft className="mr-1 h-4 w-4" />
            Back
          </Button>
        ) : (
          <span />
        )}
        {generateOnly && onGenerate ? (
          <Button
            size="lg"
            onClick={onGenerate}
            disabled={launchBlocked}
            className="bg-gradient-to-br from-blue-500 to-cyan-500 text-white shadow-lg shadow-blue-500/25 hover:from-blue-600 hover:to-cyan-600"
          >
            {isLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Generate sample files
          </Button>
        ) : (
          <Button
            size="lg"
            onClick={onLoad}
            disabled={launchBlocked || !form.connectionId || expired}
            className="bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-lg shadow-emerald-500/25 hover:from-emerald-600 hover:to-teal-600"
          >
            {isLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="mr-2 h-4 w-4" />
            )}
            Load into QuickBooks
          </Button>
        )}
      </div>

      {!generateOnly && !form.connectionId && (
        <p className="text-center text-sm text-destructive">
          No QuickBooks sandbox selected. Connect a sandbox first.
        </p>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback, useRef } from "react";
import {
  useConnections,
  useJobs,
  useJobUsage,
  useCreateJob,
  useDeleteConnection,
  useTestConnection,
  useConnectionHealth,
  useExpiredConnectionIds,
  usePurgeConnection,
  useIndustryTemplates,
  useScenarioPresets
} from "@/api/hooks";
import { useAppConfig } from "@/contexts/AppConfigContext";
import { connectErrorMessage } from "@/connect-errors";
import {
  useScenarioForm,
  WizardStepper,
  ConnectStep,
  LoadStep,
  InlineJobProgress,
  StatusBadge,
  JobTypeIcon,
  jobTypeLabel,
  ConfirmDialog,
  EraseConfirmDialog,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Badge,
  Button,
  Skeleton,
  Progress,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  timeAgo,
  formatDuration,
  formatNumber,
  cn
} from "@easytestdata/ui";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  JobDetailSheet,
  JobProgressModal,
  formatTemplateName,
  startRollback,
  displayStatus
} from "@easytestdata/ui";
import {
  Clock,
  PlugZap,
  Trash2,
  Unlink,
  Loader2,
  Link2,
  Eraser,
  Plus,
  Download
} from "lucide-react";
import type { Job, JobResultSummary } from "@/api/client";
import { getScenarioPreset, authorizeConnection, cancelJob, estimateJob } from "@/api/client";
import type {
  QboConnection,
  IndustryTemplate,
  ScenarioPreset,
  ConnectionHealth,
  LoadEstimate
} from "@easytestdata/ui";

const WIZARD_STEPS = [
  { label: "Connect", description: "QuickBooks sandbox" },
  { label: "Load", description: "Industry & scenario" }
];

// Stable empty defaults: a fresh [] on every render would reset the scenario form each time.
const NO_CONNECTIONS: QboConnection[] = [];
const NO_JOBS: Job[] = [];

/* ── Job helpers ────────────────────────────────────────────── */

function getJobTemplateName(job: Job): string | null {
  const cfg = job.config as Record<string, unknown> | undefined;
  if (!cfg) return null;
  const templateId = cfg.templateId as string | undefined;
  if (!templateId) return null;
  return formatTemplateName(templateId);
}

/** A job's sandbox name, from the connection list (job configs never carry it). */
function getJobConnectionName(job: Job, connections: QboConnection[]): string | null {
  const id = job.connection_id ?? (job.config as Record<string, unknown> | undefined)?.connectionId;
  return connections.find((c) => c.id === id)?.company_name || null;
}

// Load results report counts as `<type>Created`; generate/export results only carry plan metrics.
const ONE_LINER_FIELDS: Array<[string, string, string]> = [
  ["invoicesCreated", "invoiceCount", "invoices"],
  ["billsCreated", "billCount", "bills"],
  ["customersCreated", "customerCount", "customers"],
  ["paymentsCreated", "paymentCount", "payments"]
];

export function getResultOneLiner(job: Job): string | null {
  const rs = job.result_summary as JobResultSummary | null | undefined;
  if (!rs) return null;

  if (job.type === "purge") {
    const total = rs.deletedTotal ?? rs.totalDeleted ?? 0;
    return total > 0 ? `${formatNumber(total)} deleted` : null;
  }

  if (job.type === "rollback") {
    const total = (rs.totalDeleted ?? rs.deletedTotal ?? 0) + (rs.totalInactivated ?? 0);
    return total > 0 ? `${formatNumber(total)} rolled back` : null;
  }

  const counts = rs.counts;
  const metrics = rs.metrics;
  if (!counts && !metrics) return null;
  const parts: string[] = [];
  for (const [countKey, metricKey, label] of ONE_LINER_FIELDS) {
    const value = counts
      ? counts[countKey]
      : (metrics as Record<string, number | null | undefined> | null | undefined)?.[metricKey];
    if (value) parts.push(`${formatNumber(value)} ${label}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * True when this connection already holds data from an earlier EasyTestData load: the server's
 * per-connection flag (covers loads of any age), or a load in the recent job list (covers one
 * that finished since the connections were fetched).
 */
export function connectionHasPreviousLoad(
  jobs: Job[],
  connections: QboConnection[],
  connectionId: string
): boolean {
  if (!connectionId) return false;
  if (connections.some((conn) => conn.id === connectionId && conn.has_prior_load)) return true;
  return jobs.some(
    (job) =>
      job.type === "load" &&
      (job.status === "completed" || job.status === "failed_with_orphans") &&
      (job.config as Record<string, unknown> | undefined)?.connectionId === connectionId
  );
}

/* ── LoadStep wrapper that fetches connectionHealth ──────────── */

type LoadStepProps = Parameters<typeof LoadStep>[0];

function LoadStepWithHealth(props: Omit<LoadStepProps, "connectionHealth">) {
  const { data: connectionHealth } = useConnectionHealth(
    props.generateOnly ? undefined : props.form.connectionId || undefined
  );
  return (
    <LoadStep {...props} connectionHealth={connectionHealth as ConnectionHealth | undefined} />
  );
}

/* ── Per-connection health dot ──────────────────────────────── */

function ConnectionHealthDot({ connectionId }: { connectionId: string }) {
  const { data: health } = useConnectionHealth(connectionId);
  // Grey until the check answers: green must mean "checked and healthy", not "not checked yet".
  const color = !health
    ? "bg-slate-300"
    : health.status === "expired"
      ? "bg-red-500"
      : health.status === "warning"
        ? "bg-amber-500"
        : "bg-emerald-500";
  return <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

/* ── Reconnect for an expired sandbox ───────────────────────── */

/**
 * Shown when either the list's age-based status or the detailed health check (which also catches
 * stored tokens that can no longer be read) says the sandbox is expired. Without Intuit keys the
 * authorize call can only fail, so local mode goes to the setup page and Cloud shows nothing.
 */
function ReconnectButton({
  connection,
  canAuthorize,
  setupHref,
  onReconnect
}: {
  connection: QboConnection;
  canAuthorize: boolean;
  setupHref?: string;
  onReconnect: () => void;
}) {
  const { data: health } = useConnectionHealth(connection.id);
  const expired = connection.tokenHealth === "expired" || health?.status === "expired";
  if (!expired || (!canAuthorize && !setupHref)) return null;
  const label = (
    <>
      <Link2 className="mr-1 h-3.5 w-3.5" />
      Reconnect
    </>
  );
  if (!canAuthorize) {
    return (
      <Button size="sm" className="h-7 px-2 text-xs" asChild>
        <a href={setupHref} onClick={(e) => e.stopPropagation()}>
          {label}
        </a>
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      className="h-7 px-2 text-xs"
      onClick={(e) => {
        e.stopPropagation();
        onReconnect();
      }}
    >
      {label}
    </Button>
  );
}

/* ── Monthly load allowance (Cloud) ─────────────────────────── */

/** "3 of 10 loads this month" on Cloud; nothing where loads are unlimited (local mode). */
function LoadAllowance() {
  const { data } = useJobUsage();
  const limit = data?.limits?.loadsPerMonth;
  if (!data || limit == null || limit < 0) return null;
  const used = data.usage?.loads ?? 0;
  if (used < limit) {
    return (
      <p className="mt-1 text-sm text-muted-foreground">
        {used} of {limit} loads this month. Downloading sample files and removing data don&apos;t
        count.
      </p>
    );
  }
  return (
    <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      You&apos;ve used all {limit} loads this month; they reset on the 1st. Downloading sample files
      and removing data still work, or run EasyTestData locally for no limits.
    </p>
  );
}

/* ── Main component ─────────────────────────────────────────── */

export function HomePage() {
  const { data: connections = NO_CONNECTIONS, isLoading: connectionsLoading } = useConnections();
  const { data: jobs = NO_JOBS, isLoading: jobsLoading } = useJobs();
  const createJob = useCreateJob();
  const qc = useQueryClient();
  const { deployment, qboConfigured, qboRedirectUri } = useAppConfig();

  const deleteConnection = useDeleteConnection();
  const testConnection = useTestConnection();
  const purgeConnection = usePurgeConnection();
  // The detailed health check also catches unreadable stored tokens the list status cannot see.
  const expiredConnectionIds = useExpiredConnectionIds(connections.map((c) => c.id));

  const hasConnection = connections.length > 0;
  const isFirstTime = !hasConnection && jobs.length === 0;
  const [wizardMode, setWizardMode] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [loadingJob, setLoadingJob] = useState(false);
  const [disconnectId, setDisconnectId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [generateOnly, setGenerateOnly] = useState(false);
  const [purgeConfirmId, setPurgeConfirmId] = useState<string | null>(null);
  // "Erase ALL" lives only on the dashboard's connection bar (owner/admin gated by the server).
  const [eraseConnectionId, setEraseConnectionId] = useState<string | null>(null);
  const [connectionActionPending, setConnectionActionPending] = useState(false);
  const [estimate, setEstimate] = useState<LoadEstimate | null>(null);
  const [isEstimating, setIsEstimating] = useState(false);
  const [estimateFailed, setEstimateFailed] = useState(false);
  const connectionActionPendingRef = useRef(false);
  const jobLaunchPendingRef = useRef(false);

  const clearConnectionActionPending = () => {
    connectionActionPendingRef.current = false;
    setConnectionActionPending(false);
  };

  const runConnectionAction = (action: () => void) => {
    if (connectionActionPendingRef.current) return;
    connectionActionPendingRef.current = true;
    setConnectionActionPending(true);
    try {
      action();
    } catch (err) {
      clearConnectionActionPending();
      throw err;
    }
  };

  const runJobLaunch = async (action: () => Promise<void>, failureMessage: string) => {
    if (jobLaunchPendingRef.current) return;
    jobLaunchPendingRef.current = true;
    setLoadingJob(true);
    try {
      await action();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : failureMessage);
    } finally {
      jobLaunchPendingRef.current = false;
      setLoadingJob(false);
    }
  };

  // Job detail state
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [progressModalOpen, setProgressModalOpen] = useState(false);

  // Auto-enter wizard for first-time users
  useEffect(() => {
    if (!connectionsLoading && !jobsLoading && isFirstTime) {
      setWizardMode(true);
    }
  }, [connectionsLoading, jobsLoading, isFirstTime]);

  // Auto-advance the wizard once a sandbox is added while on the Connect step. Only a new
  // connection advances it: a user who already has sandboxes and opens "Add sandbox" stays on
  // the Connect step until they add one or click Continue.
  const connectionCountRef = useRef(connections.length);
  useEffect(() => {
    const previous = connectionCountRef.current;
    connectionCountRef.current = connections.length;
    if (wizardMode && wizardStep === 0 && connections.length > previous) {
      setGenerateOnly(false);
      setWizardStep(1);
    }
  }, [wizardMode, wizardStep, connections.length]);

  // Track running jobs
  useEffect(() => {
    if (activeJob) {
      const updatedJob = jobs.find((j) => j.id === activeJob.id);
      if (updatedJob) setActiveJob(updatedJob);
    }
  }, [jobs, activeJob]);

  const { data: templates = [], isLoading: isLoadingTemplates } = useIndustryTemplates();
  const { data: presets = [], isLoading: isLoadingPresets } = useScenarioPresets();

  const {
    form,
    setField,
    setRatio,
    applyPreset,
    overrideCount,
    serializeConfig,
    advancedOpen,
    setAdvancedOpen
  } = useScenarioForm(true, connections, getScenarioPreset);

  // Summarise what the current choice creates ("~800 records: 20 customers, 240 invoices...").
  useEffect(() => {
    const { template: templateId, config } = serializeConfig();
    if (!templateId || !config.startDate || !config.endDate) {
      // Nothing to estimate yet; never leave an earlier choice's numbers on screen.
      setEstimate(null);
      setEstimateFailed(false);
      setIsEstimating(false);
      return;
    }
    let cancelled = false;
    setIsEstimating(true);
    const timer = setTimeout(() => {
      estimateJob({ templateId, config })
        .then((result) => {
          if (cancelled) return;
          setEstimate(result);
          setEstimateFailed(false);
        })
        .catch(() => {
          if (cancelled) return;
          setEstimate(null);
          setEstimateFailed(true);
        })
        .finally(() => {
          if (!cancelled) setIsEstimating(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [serializeConfig]);

  const connectionControlsPending =
    connectionActionPending ||
    deleteConnection.isPending ||
    testConnection.isPending ||
    purgeConnection.isPending;

  const handleJobUpdate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["jobs"] });
  }, [qc]);

  // A job started from a job's details (roll back, re-run) shows its progress where loads do.
  const showStartedJob = useCallback(
    (job: Job) => {
      setSheetOpen(false);
      setProgressModalOpen(false);
      setActiveJob(job);
      handleJobUpdate();
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [handleJobUpdate]
  );

  async function handleRollback(jobId: string) {
    const started = await startRollback(jobId);
    handleJobUpdate();
    if (started) showStartedJob(started);
  }

  function openJobDetail(job: Job) {
    setSelectedJob(job);
    if (job.status === "running" || job.status === "pending") {
      setProgressModalOpen(true);
    } else {
      setSheetOpen(true);
    }
  }

  async function handleGenerate() {
    await runJobLaunch(async () => {
      const { template: templateId, config } = serializeConfig();
      // A downloaded file never touches a sandbox.
      const { connectionId: _connectionId, purgeMode: _purgeMode, ...fileConfig } = config;

      const job = await createJob.mutateAsync({ type: "generate", templateId, config: fileConfig });

      setActiveJob(job);
      toast.success("Generating sample files...");
    }, "Failed to start generation");
  }

  async function handleLoad() {
    await runJobLaunch(async () => {
      const { template: templateId, config } = serializeConfig();
      const { connectionId, ...loadConfig } = config;
      // "Clear the previous data first" is only offered for a sandbox that has an earlier load;
      // a choice made for another sandbox must not carry over silently.
      if (!connectionHasPreviousLoad(jobs, connections, form.connectionId))
        delete loadConfig.purgeMode;

      const job = await createJob.mutateAsync({
        type: "load",
        connectionId: connectionId as string | undefined,
        templateId,
        config: loadConfig
      });

      setActiveJob(job);
      toast.success("Loading your company into QuickBooks...");
    }, "Failed to start job");
  }

  // Reconnecting the same company updates its existing connection (no new sandbox, no limit).
  async function handleReconnect() {
    try {
      const data = await authorizeConnection("redirect");
      if (data?.url) window.location.href = data.url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start reconnecting");
    }
  }

  function handleTestConnection(id: string) {
    runConnectionAction(() => {
      setTestingId(id);
      testConnection.mutate(id, {
        onSuccess: (data) => {
          if (data.ok) {
            toast.success(`Connected to ${data.companyName}`);
          } else {
            toast.error(data.error || "Connection test failed");
          }
        },
        onError: () => {
          toast.error("Connection test failed");
        },
        onSettled: () => {
          setTestingId(null);
          clearConnectionActionPending();
        }
      });
    });
  }

  function handleDisconnect() {
    if (!disconnectId) return;
    runConnectionAction(() =>
      deleteConnection.mutate(disconnectId, {
        onSuccess: () => {
          toast.success("Sandbox disconnected");
          setDisconnectId(null);
        },
        onError: (err) =>
          toast.error(
            err instanceof Error && err.message ? err.message : "Failed to disconnect sandbox"
          ),
        onSettled: clearConnectionActionPending
      })
    );
  }

  function handlePurge() {
    if (!purgeConfirmId) return;
    runConnectionAction(() =>
      purgeConnection.mutate(
        { id: purgeConfirmId },
        {
          onSuccess: (job) => {
            toast.success("Removing test data...");
            setActiveJob(job);
            setPurgeConfirmId(null);
          },
          onError: () => toast.error("Failed to start removing test data"),
          onSettled: clearConnectionActionPending
        }
      )
    );
  }

  function handleEraseAll() {
    if (!eraseConnectionId) return;
    runConnectionAction(() =>
      purgeConnection.mutate(
        { id: eraseConnectionId, mode: "all" },
        {
          onSuccess: (job) => {
            toast.success("Erasing all data in the sandbox...");
            setActiveJob(job);
            setEraseConnectionId(null);
          },
          onError: () => toast.error("Failed to start erasing the sandbox"),
          onSettled: clearConnectionActionPending
        }
      )
    );
  }

  function handleLoadMoreReset() {
    setActiveJob(null);
    setWizardMode(false);
  }

  function handleStartConnectionFlow() {
    setGenerateOnly(false);
    setWizardStep(0);
    setWizardMode(true);
  }

  function handleStartGenerateOnlyFlow() {
    setActiveJob(null);
    setGenerateOnly(true);
    setWizardStep(1);
    setWizardMode(true);
  }

  if (connectionsLoading || jobsLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const loadStepProps = {
    form,
    setField,
    setRatio,
    applyPreset,
    overrideCount,
    advancedOpen,
    setAdvancedOpen,
    connections,
    templates: templates as IndustryTemplate[],
    isLoadingTemplates,
    presets: presets as ScenarioPreset[],
    isLoadingPresets,
    estimate,
    isEstimating,
    estimateFailed,
    hasPreviousLoad: connectionHasPreviousLoad(jobs, connections, form.connectionId),
    activeJob,
    isLoading: loadingJob,
    onJobUpdate: handleJobUpdate,
    onLoadMore: handleLoadMoreReset,
    onLoad: handleLoad,
    onGenerate: handleGenerate,
    onCancelJob: async (id: string) => {
      await cancelJob(id);
      handleJobUpdate();
    },
    onRollback: handleRollback,
    onViewDetails: openJobDetail
  };

  // Wizard mode
  if (wizardMode) {
    const loadWithoutConnection = generateOnly || !hasConnection;
    return (
      <div className="space-y-8">
        <div className="relative overflow-hidden rounded-xl bg-[#0c1222] p-8 text-center">
          {/* Radial glow */}
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-[300px] w-[300px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-500/10 blur-3xl" />
          <div className="relative z-10">
            <h1 className="text-2xl font-bold tracking-tight text-white">
              {isFirstTime ? "Welcome to EasyTestData" : "Load test data"}
            </h1>
            <p className="mt-1 text-slate-400">
              {isFirstTime
                ? "Connect a QuickBooks Online sandbox and load a realistic company into it, or download the data as a file."
                : "Load a new company into your sandbox."}
            </p>
          </div>
        </div>

        <WizardStepper steps={WIZARD_STEPS} currentStep={wizardStep} />

        <div className="mx-auto max-w-3xl">
          {wizardStep === 0 && (
            <ConnectStep
              connections={connections}
              onConnected={() => setWizardStep(1)}
              onSkipToGenerate={() => {
                setGenerateOnly(true);
                setWizardStep(1);
              }}
              onDeleteConnection={async (id) => {
                await deleteConnection.mutateAsync(id);
              }}
              onTestConnection={async (id) => testConnection.mutateAsync(id)}
              onAuthorizeConnection={authorizeConnection}
              onConnectionsInvalidate={() => qc.invalidateQueries({ queryKey: ["connections"] })}
              qboConfigured={qboConfigured}
              qboRedirectUri={qboRedirectUri}
              // Local mode takes the Intuit keys on /setup; generating files never needs them.
              setupHref={deployment === "local" ? "/setup" : undefined}
              describeConnectError={connectErrorMessage}
              expiredConnectionIds={expiredConnectionIds}
            />
          )}

          {wizardStep === 1 && (
            <LoadStepWithHealth
              {...loadStepProps}
              generateOnly={loadWithoutConnection}
              onBack={() => (hasConnection ? setWizardMode(false) : setWizardStep(0))}
            />
          )}
        </div>
      </div>
    );
  }

  // Returning user view
  const runningJobs = jobs.filter(
    (j) => (j.status === "running" || j.status === "pending") && j.id !== activeJob?.id
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Load test data</h1>
        <p className="mt-1 text-muted-foreground">
          Pick an industry and load a realistic company into your QuickBooks sandbox.
        </p>
        <LoadAllowance />
      </div>

      {/* Multi-connection bar */}
      {hasConnection ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-muted-foreground">Sandbox connections</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={handleStartConnectionFlow}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add sandbox
            </Button>
          </div>
          {connections.map((conn) => (
            <div
              key={conn.id}
              onClick={() => setField("connectionId", conn.id)}
              className={cn(
                "flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm cursor-pointer transition-colors",
                form.connectionId === conn.id
                  ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                  : "bg-muted/40 hover:bg-muted/60"
              )}
            >
              <ConnectionHealthDot connectionId={conn.id} />
              {/* The row is clickable with a mouse; this button makes selecting it keyboard-reachable. */}
              <button
                type="button"
                aria-pressed={form.connectionId === conn.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setField("connectionId", conn.id);
                }}
                className="min-w-0 flex-1 rounded text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {conn.company_name || "QBO Sandbox"}
                {conn.tokenHealth === "warning" && (
                  <span
                    className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
                    title="Access expires soon unless this sandbox is used. Click Test connection (the plug icon) to renew it."
                  >
                    Token expiring
                  </span>
                )}
                {conn.tokenHealth === "expired" && (
                  <span
                    className="ml-2 inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800"
                    title="Token expired. Click Reconnect and pick this company in Intuit."
                  >
                    Expired
                  </span>
                )}
              </button>
              <div className="flex items-center gap-1">
                <ReconnectButton
                  connection={conn}
                  canAuthorize={qboConfigured}
                  setupHref={deployment === "local" ? "/setup" : undefined}
                  onReconnect={() => void handleReconnect()}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  aria-label={`Remove test data from ${conn.company_name || "QBO Sandbox"}`}
                  title="Delete EasyTestData's transactions (tagged EZTD). Your own records stay."
                  onClick={(e) => {
                    e.stopPropagation();
                    setPurgeConfirmId(conn.id);
                  }}
                  disabled={connectionControlsPending}
                >
                  <Eraser className="mr-1 h-3.5 w-3.5" />
                  Remove test data
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
                  aria-label={`Erase all data in ${conn.company_name || "QBO Sandbox"}`}
                  title="Delete every transaction of the types EasyTestData loads, including ones you entered (owner or admin only)"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEraseConnectionId(conn.id);
                  }}
                  disabled={connectionControlsPending}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  Erase all data...
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  aria-label={`Test ${conn.company_name || "QBO Sandbox"}`}
                  title="Test connection"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleTestConnection(conn.id);
                  }}
                  disabled={connectionControlsPending || testingId === conn.id}
                >
                  {testingId === conn.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <PlugZap className="h-3.5 w-3.5" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  aria-label={`Disconnect ${conn.company_name || "QBO Sandbox"}`}
                  title="Disconnect"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDisconnectId(conn.id);
                  }}
                  disabled={connectionControlsPending}
                >
                  <Unlink className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm sm:flex-row sm:items-center">
          <div className="flex items-center gap-2 text-amber-900">
            <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
            <span className="font-medium">No QuickBooks sandbox connected</span>
          </div>
          <div className="text-amber-800/90 sm:ml-auto">
            Connect a sandbox to load data, or make sample files instead.
          </div>
          <Button size="sm" variant="outline" onClick={handleStartGenerateOnlyFlow}>
            <Download className="mr-2 h-4 w-4" />
            Make sample files
          </Button>
          <Button size="sm" onClick={handleStartConnectionFlow}>
            <Link2 className="mr-2 h-4 w-4" />
            Connect sandbox
          </Button>
        </div>
      )}

      {/* Running jobs started elsewhere (another tab, the API) */}
      {runningJobs.map((job) => (
        <InlineJobProgress
          key={job.id}
          job={job}
          onJobUpdate={handleJobUpdate}
          onLoadMore={handleLoadMoreReset}
          connectionName={connections.find((c) => c.id === job.config?.connectionId)?.company_name}
          onCancelJob={async (id) => {
            await cancelJob(id);
            handleJobUpdate();
          }}
          onRollback={handleRollback}
          onViewDetails={openJobDetail}
        />
      ))}

      {/* One-screen load: industry cards, scenario summary, Customize, Load button */}
      {hasConnection && <LoadStepWithHealth {...loadStepProps} />}

      {/* Recent activity — full job table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Recent activity
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {jobs.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">
              No jobs yet. Pick an industry above and load your first company.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Details</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden sm:table-cell">Summary</TableHead>
                    <TableHead className="hidden sm:table-cell">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((job) => {
                    const templateName = getJobTemplateName(job);
                    const connectionName = getJobConnectionName(job, connections);
                    const summary = getResultOneLiner(job);
                    return (
                      <TableRow
                        key={job.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => openJobDetail(job)}
                      >
                        <TableCell>
                          <div className="flex items-center gap-1.5 font-medium">
                            <JobTypeIcon type={job.type} />
                            {jobTypeLabel(job)}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            {templateName && (
                              <Badge variant="outline" className="w-fit text-xs">
                                {templateName}
                              </Badge>
                            )}
                            {connectionName && (
                              <span className="text-xs text-muted-foreground">
                                {connectionName}
                              </span>
                            )}
                            {!templateName && !connectionName && (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-2">
                              <StatusBadge status={displayStatus(job)} />
                              {job.status === "running" && typeof job.progress === "number" && (
                                <Progress value={job.progress} className="h-1.5 w-20" />
                              )}
                            </div>
                            {job.status === "completed" && job.started_at && job.completed_at && (
                              <span className="text-xs text-muted-foreground">
                                {formatDuration(job.started_at, job.completed_at)}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-muted-foreground text-sm">
                          {summary ||
                            (job.entity_count ? `${formatNumber(job.entity_count)} records` : "-")}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-muted-foreground">
                          {timeAgo(job.created_at)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Job detail sheet / progress modal */}
      <JobDetailSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        job={selectedJob}
        onJobUpdate={handleJobUpdate}
        onJobStarted={showStartedJob}
        connectionName={
          selectedJob ? getJobConnectionName(selectedJob, connections) || undefined : undefined
        }
      />

      <JobProgressModal
        open={progressModalOpen}
        onOpenChange={setProgressModalOpen}
        job={selectedJob}
        onJobUpdate={handleJobUpdate}
        onJobStarted={showStartedJob}
      />

      <ConfirmDialog
        open={!!disconnectId}
        onOpenChange={(open) => !open && setDisconnectId(null)}
        title={`Disconnect ${
          connections.find((c) => c.id === disconnectId)?.company_name || "this sandbox"
        }?`}
        description="EasyTestData forgets this sandbox and its tokens. Data already in QuickBooks stays. You can reconnect anytime."
        confirmLabel="Disconnect"
        onConfirm={handleDisconnect}
        destructive
        pending={connectionControlsPending}
        pendingLabel="Disconnecting..."
      />

      <ConfirmDialog
        open={!!purgeConfirmId}
        onOpenChange={(open) => !open && setPurgeConfirmId(null)}
        title="Remove test data?"
        description="This deletes the transactions EasyTestData added (tagged EZTD) and makes its customers, vendors, employees and items inactive (QuickBooks can't delete them). Accounts it created stay. Records you created by hand are not touched."
        confirmLabel="Remove test data"
        onConfirm={handlePurge}
        destructive
        pending={connectionControlsPending}
        pendingLabel="Starting..."
      />

      <EraseConfirmDialog
        open={eraseConnectionId !== null}
        onOpenChange={(open) => !open && setEraseConnectionId(null)}
        onConfirm={handleEraseAll}
        pending={connectionControlsPending}
      />
    </div>
  );
}

// Shared domain types — single source of truth for UI + API client packages

export interface QboConnection {
  id: string;
  realm_id: string;
  company_name: string;
  base_url: string;
  connected_at: string;
  last_used_at: string | null;
  tokenHealth?: "ok" | "warning" | "expired";
  /** The sandbox holds data from an earlier load (completed, or failed with records left). */
  has_prior_load?: boolean;
}

export interface JobMetrics {
  /** What a load or download plan actually generated (core's plan metrics). */
  totalRevenueGenerated?: number;
  totalExpensesGenerated?: number;
  ebitdaGenerated?: number;
  revenue?: number;
  expenses?: number;
  ebitda?: number;
  netIncome?: number;
  totalInvoices?: number;
  totalBills?: number;
  totalPayments?: number;
  totalCustomers?: number;
  totalVendors?: number;
  totalEmployees?: number;
  [key: string]: number | undefined;
}

export interface JobArtifact {
  filename: string;
  format: string;
  mimeType?: string;
}

export interface JobResultSummary {
  metrics?: JobMetrics | null;
  counts?: Record<string, number> | null;
  artifact?: JobArtifact | null;
  /** Every downloadable format written for the job, keyed by format. */
  artifacts?: Partial<Record<"json" | "csv", JobArtifact>> | null;
  deletedByEntity?: Record<string, number> | null;
  deletedTotal?: number | null;
  masterData?: Record<string, number> | null;
  failureCount?: number | null;
  totalDeleted?: number | null;
  /** Rollback: master data made inactive (QBO cannot delete it). */
  totalInactivated?: number | null;
  /** Rollback: why master data was kept (a later load may use it). */
  note?: string | null;
}

export interface Job {
  id: string;
  type: string;
  status: string;
  /** The sandbox a load/purge/rollback ran against; null for generate/export. */
  connection_id?: string | null;
  config: Record<string, unknown>;
  progress: unknown;
  result: unknown;
  error: string | null;
  entity_count: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  result_summary?: JobResultSummary | null;
  /** A load whose rollback completed (its status stays failed; its records are gone). */
  rolled_back?: boolean;
}

/** A scenario preset: sizes, ratio overrides and an optional period. */
export interface ScenarioPreset {
  id: string;
  name: string;
  description?: string;
  request?: Record<string, unknown>;
  ratioOverrides?: Record<string, number>;
  /** Suggested period length; the client pairs it with the last N full months. */
  months?: number;
}

export interface ScenarioPresetDetail {
  id: string;
  name: string;
  description: string;
  request: Record<string, unknown>;
  ratioOverrides: Record<string, number>;
  months?: number;
}

/** Response of POST /jobs/estimate: what a load would create. */
export interface LoadEstimate {
  estimatedEntities: number;
  metrics?: Record<string, number> | null;
  /** Records allowed per job; -1 means unlimited (local mode). */
  limit: number;
}

export interface IndustryTemplate {
  id: string;
  name: string;
  description: string;
}

export interface ConnectionHealth {
  connectionId: string;
  status: "healthy" | "warning" | "expired";
  daysSinceActivity: number;
  warnings: string[];
}

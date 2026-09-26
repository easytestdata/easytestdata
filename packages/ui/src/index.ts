// Utilities
export { cn } from "./lib/utils";
export { defaultPeriod } from "./lib/period";
export {
  timeAgo,
  formatCurrency,
  formatNumber,
  formatDuration,
  formatDateRange,
  countryName,
  formatTemplateName
} from "./lib/format";

// UI Primitives
export * from "./components/ui/alert-dialog";
export * from "./components/ui/alert";
export * from "./components/ui/avatar";
export * from "./components/ui/badge";
export * from "./components/ui/button";
export * from "./components/ui/card";
export * from "./components/ui/dialog";
export * from "./components/ui/dropdown-menu";
export * from "./components/ui/input";
export * from "./components/ui/label";
export * from "./components/ui/progress";
export * from "./components/ui/select";
export * from "./components/ui/separator";
export * from "./components/ui/sheet";
export * from "./components/ui/skeleton";
export * from "./components/ui/sonner";
export * from "./components/ui/switch";
export * from "./components/ui/table";
export * from "./components/ui/tabs";
export * from "./components/ui/tooltip";

// Shared Components
export { JobProgressModal } from "./components/JobProgressModal";
export { JobDetailSheet, loadAgainDescription } from "./components/JobDetailSheet";
export {
  JobDownloadButtons,
  getJobDownloadFormats
} from "./components/job-detail/JobDownloadButtons";
export { ConfirmDialog } from "./components/ConfirmDialog";
export { EraseConfirmDialog } from "./components/EraseConfirmDialog";
export { EmptyState } from "./components/EmptyState";
export { StatusBadge, displayStatus } from "./components/StatusBadge";
export { SandboxBadge } from "./components/SandboxBadge";
export { REPO_URL, SANDBOX_GUARD_SOURCE_URL } from "./components/TrustBanner";
export { TrustBanner } from "./components/TrustBanner";

// SVG Illustrations
export { BrandLogo } from "./components/svg/BrandLogo";
export { ChecklistSvg } from "./components/svg/ChecklistSvg";
export { DataPreviewSvg } from "./components/svg/DataPreviewSvg";
export { EmptyHistorySvg } from "./components/svg/EmptyHistorySvg";
export { EmptyTeamSvg } from "./components/svg/EmptyTeamSvg";
export { JobTypeIcon, jobTypeLabel } from "./components/svg/JobTypeIcon";
export { OAuthFlowSvg } from "./components/svg/OAuthFlowSvg";
export { SuccessFlowSvg } from "./components/svg/SuccessFlowSvg";

// Shared Types
export type {
  QboConnection,
  Job,
  JobResultSummary,
  JobArtifact,
  JobMetrics,
  ScenarioPreset,
  ScenarioPresetDetail,
  IndustryTemplate,
  ConnectionHealth,
  LoadEstimate
} from "./types";

// Wizard Components
export { ConnectStep } from "./components/wizard/ConnectStep";
export { TemplateCards, TEMPLATE_ICONS } from "./components/wizard/TemplateCards";
export { PresetCards, PRESET_ICONS, orderScenarios } from "./components/wizard/PresetCards";
export { QuickCustomize } from "./components/wizard/QuickCustomize";
export {
  LoadStep,
  summarizeEstimate,
  describeDuration,
  RECORDS_PER_MINUTE
} from "./components/wizard/LoadStep";
export type { EstimateSummary } from "./components/wizard/LoadStep";
export { WizardStepper } from "./components/wizard/WizardStepper";
export { InlineJobProgress } from "./components/wizard/InlineJobProgress";

// Scenario Config Components
export { AdvancedFields } from "./components/scenario-config/AdvancedFields";
export { FieldLabel } from "./components/scenario-config/FieldLabel";
export { RatioInput } from "./components/scenario-config/RatioInput";
export {
  RATIO_FIELDS,
  RATIO_TAB_LABELS,
  getFieldsByTab
} from "./components/scenario-config/ratio-defaults";
export type {
  RatioFieldDef,
  RatioFieldType,
  RatioTab
} from "./components/scenario-config/ratio-defaults";
export {
  useScenarioForm,
  DEFAULT_TEMPLATE_ID,
  DEFAULT_PRESET_ID
} from "./components/scenario-config/useScenarioForm";
export type { ScenarioFormState } from "./components/scenario-config/useScenarioForm";

// Job Detail Components
export { JobDataViewer } from "./components/job-detail/JobDataViewer";
export { JobResultSummaryView } from "./components/job-detail/JobResultSummary";
export { JobProgressLog } from "./components/job-detail/JobProgressLog";
export { JobConfigSummary } from "./components/job-detail/JobConfigSummary";
export { JobFailuresPanel } from "./components/job-detail/JobFailuresPanel";
export { SandboxNextSteps, QBO_SANDBOX_APP_URL } from "./components/job-detail/SandboxNextSteps";
export { startRollback } from "./components/job-detail/startRollback";

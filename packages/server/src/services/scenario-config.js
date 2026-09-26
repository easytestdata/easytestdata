import { z } from "zod";
import {
  applyScenarioPreset,
  buildSyntheticPlan,
  randomSeed,
  countPeriodMonths,
  DEFAULT_TEMPLATE,
  getIndustryTemplate,
  getScenarioPreset,
  listIndustryTemplates,
  listScenarioPresets,
  MAX_EMPLOYEES,
  MAX_MONTHS,
  normalizeRequest,
  resolveConfig,
  resolvePeriod,
  resolveRequest,
  validateRatioOverrides
} from "@easytestdata/core";

// Mirrors the generator's own guard (months x customers), checked here so an oversized request
// is refused with a 400 before any plan is built for a preview, estimate or job.
const MAX_CUSTOMER_MONTHS = 5000;

const scenarioConfigSchema = z
  .object({
    // Optional: generate/export jobs build a downloadable file without a QBO connection.
    connectionId: z.string().uuid().optional(),
    templateId: z.string().min(1),
    presetId: z.string().nullable().optional(),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD")
      .refine((v) => !isNaN(Date.parse(v)), { message: "startDate is not a valid date" }),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "endDate must be YYYY-MM-DD")
      .refine((v) => !isNaN(Date.parse(v)), { message: "endDate is not a valid date" }),
    totalRevenue: z.coerce.number().positive(),
    targetEbitda: z.coerce.number(),
    customerCount: z.coerce.number().int().min(1).max(300),
    topCustomerCount: z.coerce.number().int().min(1).max(300).default(3),
    clientConcentrationPercent: z.coerce.number().min(1).max(99).default(40),
    employeeCount: z.coerce.number().int().min(0).max(MAX_EMPLOYEES).default(5),
    includeBenefits: z.boolean().optional().default(false),
    tag: z.string().min(1).default("EZTD"),
    country: z.enum(["US", "GB", "AU", "CA"]).optional().default("US"),
    purgeMode: z.enum(["none", "generated", "all"]).optional().default("none"),
    // Every key must be one of core's RATIOS and every value within core's RATIO_BOUNDS:
    // ratios drive per-month entity counts, so an unbounded one is an unbounded plan.
    ratioOverrides: z
      .record(z.string(), z.coerce.number())
      .optional()
      .default({})
      .superRefine((ratios, ctx) => {
        try {
          validateRatioOverrides(ratios);
        } catch (err) {
          ctx.addIssue({ code: "custom", message: err.message });
        }
      }),
    exportFormat: z.enum(["json", "csv"]).optional().default("json"),
    // Fixed when a job is created (see routes/jobs.js) so its estimate, its execution and any
    // re-run build the same plan.
    seed: z.coerce.number().int().min(1).max(2147483647).optional()
  })
  .superRefine((value, ctx) => {
    const issue = (message, path) => ctx.addIssue({ code: "custom", message, path: [path] });
    if (value.topCustomerCount > value.customerCount) {
      issue("topCustomerCount cannot exceed customerCount", "topCustomerCount");
    }
    if (value.endDate >= value.startDate) {
      const months = countPeriodMonths(value.startDate, value.endDate);
      if (months > MAX_MONTHS) {
        issue(`The period spans ${months} months; the maximum is ${MAX_MONTHS}`, "endDate");
      } else if (months * value.customerCount > MAX_CUSTOMER_MONTHS) {
        issue(
          `Scenario would create too many invoices (${months} months x ${value.customerCount} customers > ${MAX_CUSTOMER_MONTHS}). Reduce the date range or customer count.`,
          "customerCount"
        );
      }
    }
    if (!getIndustryTemplate(value.templateId)) {
      issue(
        `Unknown template "${value.templateId}". Valid templates: ${listIndustryTemplates()
          .map((t) => t.id)
          .join(", ")}`,
        "templateId"
      );
    }
    if (value.presetId && !getScenarioPreset(value.presetId)) {
      issue(
        `Unknown preset "${value.presetId}". Valid presets: ${listScenarioPresets()
          .map((p) => p.id)
          .join(", ")}`,
        "presetId"
      );
    }
    if (value.targetEbitda > value.totalRevenue) {
      issue("targetEbitda cannot exceed totalRevenue", "targetEbitda");
    }
    if (value.endDate < value.startDate) {
      issue("endDate must be on or after startDate", "endDate");
    }
  });

const DEFAULT_TAG = "EZTD";

function toBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true";
  return fallback;
}

/** Report a config value core rejected as a validation error (400), not a server error. */
function invalidConfig(err, path) {
  const message = err instanceof Error ? err.message : String(err);
  return new z.ZodError([{ code: "custom", message, path: [path] }]);
}

function pick(...values) {
  return values.find((v) => v !== undefined && v !== null && v !== "");
}

/**
 * Normalize a stored/posted scenario config. Values resolve like core's `generate()`: explicit
 * config value > scenario preset > core's DEFAULT_REQUEST, and the period comes from
 * startDate/endDate/months (default: the 12 full months before today). Throws a ZodError
 * (mapped to 400) for invalid values, unknown template/preset ids, or targetEbitda above
 * totalRevenue, so a bad scenario is rejected before any job is created.
 */
export function normalizeScenarioConfig(rawConfig, templateIdFallback = DEFAULT_TEMPLATE) {
  const raw = rawConfig || {};
  const templateId = String(raw.templateId || templateIdFallback || DEFAULT_TEMPLATE);
  const presetId = pick(raw.presetId) ?? null;
  const knownPreset = presetId && getScenarioPreset(presetId) ? presetId : undefined;

  let request;
  try {
    ({ request } = resolveRequest({
      totalRevenue: pick(raw.totalRevenue),
      targetEbitda: pick(raw.targetEbitda),
      customerCount: pick(raw.customerCount),
      topCustomerCount: pick(raw.topCustomerCount),
      clientConcentrationPercent: pick(raw.clientConcentrationPercent),
      employeeCount: pick(raw.employeeCount),
      includeBenefits: pick(raw.includeBenefits),
      // An unknown preset is reported by the schema below with the list of valid ids.
      preset: knownPreset
    }));
  } catch (err) {
    throw invalidConfig(err, "config");
  }

  // Period precedence matches core's generate(): explicit months or both dates > the scenario
  // preset's own length (quick-demo is 3 months) > the default 12 months.
  const presetMonths = knownPreset ? getScenarioPreset(knownPreset).months : undefined;
  const explicitMonths = pick(raw.months);
  const bothDates = Boolean(raw.startDate && raw.endDate);
  let period;
  try {
    period = resolvePeriod({
      startDate: raw.startDate || undefined,
      endDate: raw.endDate || undefined,
      months: explicitMonths ?? (bothDates ? undefined : presetMonths)
    });
  } catch (err) {
    throw invalidConfig(err, "months");
  }

  const normalized = {
    connectionId: raw.connectionId || undefined,
    templateId,
    presetId,
    ...period,
    totalRevenue: Number(request.totalRevenue),
    targetEbitda: Number(request.targetEbitda),
    customerCount: Number(request.customerCount),
    topCustomerCount: Number(request.topCustomerCount),
    clientConcentrationPercent: Number(request.clientConcentrationPercent),
    employeeCount: Number(request.employeeCount),
    includeBenefits: toBool(request.includeBenefits, false),
    tag: String(raw.tag || DEFAULT_TAG)
      .trim()
      .toUpperCase(),
    country: String(raw.country || "US").toUpperCase(),
    purgeMode: raw.purgeMode || "none",
    ratioOverrides: raw.ratioOverrides || {},
    exportFormat: raw.exportFormat === "csv" ? "csv" : "json",
    seed: raw.seed ?? undefined
  };

  return scenarioConfigSchema.parse(normalized);
}

export function resolveScenarioGeneration(config) {
  const template = getIndustryTemplate(config.templateId);
  if (!template) {
    throw new Error(`Unknown template: ${config.templateId}`);
  }

  const baseRequest = {
    startDate: config.startDate,
    endDate: config.endDate,
    totalRevenue: config.totalRevenue,
    targetEbitda: config.targetEbitda,
    customerCount: config.customerCount,
    topCustomerCount: config.topCustomerCount,
    clientConcentrationPercent: config.clientConcentrationPercent,
    employeeCount: config.employeeCount,
    includeBenefits: config.includeBenefits,
    tag: config.tag,
    country: config.country || "US",
    ratioOverrides: config.ratioOverrides || {}
  };

  const withPreset = applyScenarioPreset(baseRequest, config.presetId || undefined);
  const requestBody = {
    ...withPreset.request,
    tag: String(withPreset.request.tag || config.tag || "EZTD")
      .trim()
      .toUpperCase(),
    country: config.country || "US"
  };

  const country = config.country || "US";
  const resolvedConfig = resolveConfig(
    template,
    { ratios: withPreset.ratioOverrides || {} },
    country
  );
  const input = normalizeRequest(requestBody, requestBody.tag);

  return {
    requestBody,
    resolvedConfig,
    input
  };
}

/** Builds the plan with the config's seed (a fresh one, recorded in plan.meta.seed, if unset). */
export function buildPlanFromScenario(config) {
  const { input, resolvedConfig, requestBody } = resolveScenarioGeneration(config);
  const seed = config.seed ?? randomSeed();
  const plan = buildSyntheticPlan(input, resolvedConfig, { seed });
  return { plan, input, resolvedConfig, requestBody };
}

/**
 * Number of QBO entities a job for this config will create: builds the plan (tens of
 * milliseconds) and counts it, the same way the worker counts it at execution time.
 */
export function estimateEntityCount(config) {
  return estimatePlan(config).estimatedEntities;
}

/** The plan's metrics (per-type counts, revenue) plus the total record count. */
export function estimatePlan(config) {
  const { metrics } = buildPlanFromScenario(config).plan;
  return { estimatedEntities: countPlanEntities(metrics), metrics };
}

export function countPlanEntities(metrics) {
  return (
    (metrics.customerCount || 0) +
    (metrics.vendorCount || 0) +
    (metrics.employeeCount || 0) +
    (metrics.invoiceCount || 0) +
    (metrics.billCount || 0) +
    (metrics.salesReceiptCount || 0) +
    (metrics.directExpenseCount || 0) +
    (metrics.paymentCount || 0) +
    (metrics.billPaymentCount || 0) +
    (metrics.creditMemoCount || 0) +
    (metrics.refundReceiptCount || 0) +
    (metrics.vendorCreditCount || 0) +
    (metrics.depositCount || 0) +
    (metrics.transferCount || 0) +
    (metrics.journalEntryCount || 0) +
    (metrics.payrollRunCount || 0) +
    (metrics.estimateCount || 0) +
    (metrics.purchaseOrderCount || 0)
  );
}

export { scenarioConfigSchema };

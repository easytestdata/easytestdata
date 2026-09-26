import { MAX_PERIOD_MONTHS } from "./constants.js";
import { normalizeRequest, buildSyntheticPlan } from "./generator.js";
import { resolveConfig } from "./ratios.js";
import { requireIndustryTemplate } from "./templates/industries/index.js";
import { applyScenarioPreset, requireScenarioPreset } from "./templates/scenarios/index.js";

export const DEFAULT_TEMPLATE = "professional-services";
export const DEFAULT_MONTHS = 12;
export const MAX_MONTHS = MAX_PERIOD_MONTHS;

/** Built-in request defaults, used for anything neither the caller nor a preset sets. */
export const DEFAULT_REQUEST = Object.freeze({
  totalRevenue: 500000,
  targetEbitda: 100000,
  customerCount: 15,
  topCustomerCount: 3,
  clientConcentrationPercent: 40,
  employeeCount: 5,
  includeBenefits: false,
  tag: "EZTD",
  country: "US"
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A random seed in 1..2^31-1. `generate()` uses one when the caller gives no seed, and records
 * it in `plan.meta.seed`, so any run can be reproduced by passing that seed (and the same dates).
 */
export function randomSeed() {
  return Math.floor(Math.random() * 0x7fffffff) + 1;
}

function iso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseIsoDate(value, label) {
  const text = String(value);
  const ms = Date.parse(text);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(ms) || iso(ms) !== text) {
    throw new Error(`${label} must be a valid date in YYYY-MM-DD format (got "${text}").`);
  }
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
}

/**
 * Number of calendar months a period touches (a plan generates per calendar month, so
 * 2025-01-31..2025-02-01 counts as 2). Accepts YYYY-MM-DD strings or parsed {y, m} dates and
 * returns 0 for an inverted period.
 */
export function countPeriodMonths(startDate, endDate) {
  const s = typeof startDate === "object" ? startDate : parseIsoDate(startDate, "startDate");
  const e = typeof endDate === "object" ? endDate : parseIsoDate(endDate, "endDate");
  return Math.max(0, (e.y - s.y) * 12 + (e.m - s.m) + 1);
}

/**
 * Parse a money amount such as 750000, "750000", "1,000,000", "500k", "1.5M", "2m" or "-50k".
 * Returns a number, or throws on anything else.
 */
export function parseAmount(value, label = "amount") {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "")
    .trim()
    .replace(/[,_\s$]/g, "");
  const match = /^(-?\d+(?:\.\d+)?)([kKmMbB]?)$/.exec(text);
  if (!match) {
    throw new Error(
      `${label} must be an amount like 750000, 1,000,000, 500k or 1.5M (got "${value}").`
    );
  }
  const multiplier = { "": 1, k: 1e3, m: 1e6, b: 1e9 }[match[2].toLowerCase()];
  return Math.round(Number(match[1]) * multiplier * 100) / 100;
}

/**
 * Resolve the generation period.
 *
 * - startDate + endDate: used as given.
 * - startDate (+ months): `months` full months from startDate (default 12).
 * - endDate (+ months): `months` months ending on endDate (default 12).
 * - neither: the `months` full calendar months before today's month (default 12), so the
 *   data lands in QBO's "last 12 months" reports. Pass `today` for reproducible results.
 */
// Date.UTC(y, m + n, d) for a day that the target month may not have (Jan 31 + 1 month):
// clamp to that month's last day instead of letting it roll into the month after.
function addMonthsUtc(y, m, d, n) {
  const lastDay = new Date(Date.UTC(y, m + n + 1, 0)).getUTCDate();
  return Date.UTC(y, m + n, Math.min(d, lastDay));
}

function assertPeriodSpan(startDate, endDate) {
  const span = countPeriodMonths(startDate, endDate);
  if (span > MAX_MONTHS) {
    throw new Error(
      `The period from ${startDate} to ${endDate} spans ${span} months; the maximum is ${MAX_MONTHS}.`
    );
  }
}

export function resolvePeriod({ startDate, endDate, months, today = new Date() } = {}) {
  if (months != null) {
    if (!Number.isInteger(Number(months)) || Number(months) < 1 || Number(months) > MAX_MONTHS) {
      throw new Error(`months must be a whole number from 1 to ${MAX_MONTHS} (got "${months}").`);
    }
    months = Number(months);
    if (startDate && endDate) {
      throw new Error("Pass at most two of startDate, endDate and months.");
    }
  }
  const count = months ?? DEFAULT_MONTHS;

  if (startDate && endDate) {
    parseIsoDate(startDate, "startDate");
    parseIsoDate(endDate, "endDate");
    assertPeriodSpan(startDate, endDate);
    return { startDate: String(startDate), endDate: String(endDate) };
  }
  // `months` rolling months from/to a date; one that is not the 1st touches one more calendar
  // month than that, and the calendar-month bound applies as it does to explicit dates.
  if (startDate) {
    const s = parseIsoDate(startDate, "startDate");
    const period = {
      startDate: String(startDate),
      endDate: iso(addMonthsUtc(s.y, s.m, s.d, count) - DAY_MS)
    };
    assertPeriodSpan(period.startDate, period.endDate);
    return period;
  }
  if (endDate) {
    const e = parseIsoDate(endDate, "endDate");
    const next = new Date(Date.UTC(e.y, e.m, e.d) + DAY_MS);
    const period = {
      startDate: iso(
        addMonthsUtc(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), -count)
      ),
      endDate: String(endDate)
    };
    assertPeriodSpan(period.startDate, period.endDate);
    return period;
  }
  const y = today.getFullYear();
  const m = today.getMonth();
  return {
    startDate: iso(Date.UTC(y, m - count, 1)),
    endDate: iso(Date.UTC(y, m, 1) - DAY_MS)
  };
}

const REQUEST_KEYS = [
  "totalRevenue",
  "targetEbitda",
  "customerCount",
  "topCustomerCount",
  "clientConcentrationPercent",
  "employeeCount",
  "includeBenefits",
  "tag",
  "country"
];

/**
 * Build the final request: explicit options > preset > DEFAULT_REQUEST.
 * Returns { request, ratioOverrides } ready for normalizeRequest/resolveConfig.
 */
export function resolveRequest(options = {}) {
  const explicit = {};
  for (const key of REQUEST_KEYS) {
    if (options[key] !== undefined && options[key] !== null) explicit[key] = options[key];
  }
  if (explicit.totalRevenue !== undefined) {
    explicit.totalRevenue = parseAmount(explicit.totalRevenue, "totalRevenue");
  }
  if (explicit.targetEbitda !== undefined) {
    explicit.targetEbitda = parseAmount(explicit.targetEbitda, "targetEbitda");
  }

  const presetRequest = options.preset ? requireScenarioPreset(options.preset).request : {};
  const base = { ...DEFAULT_REQUEST, ...presetRequest };

  // Keep the preset/default margin when only revenue is overridden.
  if (explicit.totalRevenue !== undefined && explicit.targetEbitda === undefined) {
    const margin = base.targetEbitda / base.totalRevenue;
    explicit.targetEbitda = Math.round(explicit.totalRevenue * margin);
  }
  // Never let an inherited top-customer count exceed an explicit customer count.
  if (explicit.customerCount !== undefined && explicit.topCustomerCount === undefined) {
    explicit.topCustomerCount = Math.max(
      1,
      Math.min(base.topCustomerCount, Math.floor(Number(explicit.customerCount)) || 1)
    );
  }

  const applied = applyScenarioPreset(
    { ...explicit, ratioOverrides: options.ratios || undefined },
    options.preset
  );
  const request = { ...DEFAULT_REQUEST, ...applied.request };
  delete request.ratioOverrides;
  return { request, ratioOverrides: applied.ratioOverrides };
}

/**
 * One-call plan generation.
 *
 * @example
 * const plan = generate({ template: "saas", preset: "rapid-growth", months: 12, seed: 42 });
 *
 * @param {object} [options]
 * @param {string} [options.template="professional-services"] industry template id
 * @param {string} [options.preset] scenario preset id
 * @param {string} [options.startDate] YYYY-MM-DD
 * @param {string} [options.endDate] YYYY-MM-DD
 * @param {number} [options.months=12] period length in months (see resolvePeriod); defaults to
 *   the scenario preset's own length when it has one (quick-demo: 3)
 * @param {Date} [options.today] reference date for the default period
 * @param {number} [options.seed] makes output deterministic (with fixed dates); without one a
 *   random seed is drawn and recorded in `plan.meta.seed`
 * @param {object} [options.ratios] ratio overrides, e.g. { invoicePaymentRate: 0.7 }
 * @param {number|string} [options.totalRevenue] e.g. 500000 or "500k"
 * @param {number|string} [options.targetEbitda] may be negative, e.g. "-50k"
 * @param {number} [options.customerCount]
 * @param {number} [options.topCustomerCount]
 * @param {number} [options.clientConcentrationPercent]
 * @param {number} [options.employeeCount]
 * @param {boolean} [options.includeBenefits]
 * @param {string} [options.tag="EZTD"] marker used to find generated records for purge
 * @param {string} [options.country="US"] US, GB, AU or CA
 * @returns {object} plan (see buildSyntheticPlan)
 */
export function generate(options = {}) {
  const templateId = options.template || DEFAULT_TEMPLATE;
  const template = requireIndustryTemplate(templateId);
  const { request, ratioOverrides } = resolveRequest(options);
  // Period precedence matches everything else: explicit option > scenario preset > default.
  // A preset with its own length (quick-demo is 3 months) applies unless the caller gave
  // months or both dates.
  const presetMonths = options.preset ? requireScenarioPreset(options.preset).months : undefined;
  const months =
    options.months ?? (options.startDate && options.endDate ? undefined : presetMonths);
  const period = resolvePeriod({ ...options, months });
  const input = normalizeRequest({ ...request, ...period });
  const config = resolveConfig(template, { ratios: ratioOverrides }, input.country);
  // Always seed the plan: a seedless run still gets a concrete seed in plan.meta.seed so it can
  // be reproduced later (the CLI prints it).
  const seed = options.seed != null ? Number(options.seed) : randomSeed();
  const plan = buildSyntheticPlan(input, config, { seed });
  plan.meta.preset = options.preset || null;
  return plan;
}

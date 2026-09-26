import {
  SERVICE_ITEMS,
  EXPENSE_CATEGORIES,
  RATIOS,
  RATIO_BOUNDS,
  PAYMENT_TERMS
} from "./constants.js";
import { getLocaleConfig } from "./locales/index.js";
import { requireIndustryTemplate } from "./templates/industries/index.js";

/**
 * Deep-merge two plain objects. Arrays are replaced, not merged.
 */
function deepMerge(base, overrides) {
  if (!overrides) return { ...base };
  const result = { ...base };
  for (const key of Object.keys(overrides)) {
    const val = overrides[key];
    if (
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      result[key] = deepMerge(base[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Resolve a complete configuration by merging:
 *   1. Base defaults (constants.js)
 *   2. Template overrides (industry template)
 *   3. User overrides (CLI flags or API params)
 *
 * `template` is an industry template id (e.g. "saas"), a template object, or
 * omitted for the base defaults. Unknown template ids throw.
 *
 * Returns { industry, serviceItems, expenseCategories, ratios, paymentTerms }
 */
export function resolveConfig(template = {}, userOverrides = {}, country = "US") {
  if (typeof template === "string") template = requireIndustryTemplate(template);
  template = template || {};
  userOverrides = userOverrides || {};
  const locale = getLocaleConfig(country);
  const baseConfig = {
    serviceItems: SERVICE_ITEMS,
    expenseCategories: EXPENSE_CATEGORIES,
    ratios: RATIOS,
    paymentTerms: locale.defaultPaymentTerms || PAYMENT_TERMS
  };

  // Layer 1 -> Layer 2: apply template overrides
  const withTemplate = {
    serviceItems: template.serviceItems || baseConfig.serviceItems,
    expenseCategories: template.expenseCategories || baseConfig.expenseCategories,
    ratios: deepMerge(baseConfig.ratios, template.ratios),
    paymentTerms: template.paymentTerms || baseConfig.paymentTerms
  };

  validateRatioOverrides(userOverrides.ratios);

  // Layer 2 -> Layer 3: apply user overrides
  const resolved = {
    industry: template.id || null,
    serviceItems: userOverrides.serviceItems || withTemplate.serviceItems,
    expenseCategories: userOverrides.expenseCategories || withTemplate.expenseCategories,
    ratios: deepMerge(withTemplate.ratios, userOverrides.ratios),
    paymentTerms: userOverrides.paymentTerms || withTemplate.paymentTerms
  };

  // Template values (already validated when registered) are clamped to the documented range so
  // the merged ratios can never drive the generator past RATIO_BOUNDS.
  const r = resolved.ratios;
  for (const [key, { min, max }] of Object.entries(RATIO_BOUNDS)) {
    if (r[key] !== undefined) {
      const value = Number(r[key]);
      r[key] = Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : RATIOS[key];
    }
  }

  return resolved;
}

/**
 * Checks caller-supplied ratio overrides: every key must be a known ratio and every value a
 * finite number within RATIO_BOUNDS. Throws one Error naming each problem; returns the
 * overrides unchanged otherwise.
 */
export function validateRatioOverrides(ratios) {
  if (ratios == null) return ratios;
  if (typeof ratios !== "object" || Array.isArray(ratios)) {
    throw new Error("ratios must be an object of ratio name -> number.");
  }
  const unknown = Object.keys(ratios).filter((key) => !(key in RATIOS));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown ratio${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
        `Valid ratios: ${Object.keys(RATIOS).join(", ")}`
    );
  }
  const problems = [];
  for (const [key, raw] of Object.entries(ratios)) {
    const { min, max } = RATIO_BOUNDS[key];
    const value = typeof raw === "number" ? raw : Number(raw);
    if (typeof raw === "boolean" || raw === "" || raw == null || !Number.isFinite(value)) {
      problems.push(
        `${key} must be a number between ${min} and ${max} (got ${JSON.stringify(raw)})`
      );
    } else if (value < min || value > max) {
      problems.push(`${key} must be between ${min} and ${max} (got ${value})`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Invalid ratio override${problems.length > 1 ? "s" : ""}: ${problems.join("; ")}`
    );
  }
  return ratios;
}

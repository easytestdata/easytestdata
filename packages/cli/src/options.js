import { InvalidArgumentError } from "commander";
import {
  generate,
  parseAmount,
  requireIndustryTemplate,
  requireScenarioPreset,
  getScenarioPreset,
  SUPPORTED_COUNTRIES,
  DEFAULT_TEMPLATE
} from "@easytestdata/core";
import { parseRatioFlags } from "./ratio-parser.js";

// ---------------------------------------------------------------------------
// Option-argument parsers: bad input becomes a one-line Commander error, exit 1.
// ---------------------------------------------------------------------------

export function wholeNumber(min, max) {
  return (value) => {
    const n = Number(value);
    if (!/^-?\d+$/.test(String(value).trim()) || n < min || n > max) {
      throw new InvalidArgumentError(`Expected a whole number from ${min} to ${max}.`);
    }
    return n;
  };
}

export function amount(value) {
  try {
    return parseAmount(value);
  } catch {
    throw new InvalidArgumentError("Expected an amount like 750000, 1,000,000, 500k or 1.5M.");
  }
}

export function isoDate(value) {
  const ms = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(ms)) {
    throw new InvalidArgumentError("Expected a date in YYYY-MM-DD format.");
  }
  if (new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new InvalidArgumentError("That date does not exist.");
  }
  return value;
}

function percent(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 99) {
    throw new InvalidArgumentError("Expected a percentage from 1 to 99.");
  }
  return n;
}

function country(value) {
  const code = String(value).toUpperCase();
  if (!SUPPORTED_COUNTRIES.includes(code)) {
    throw new InvalidArgumentError(`Expected one of ${SUPPORTED_COUNTRIES.join(", ")}.`);
  }
  return code;
}

function seed(value) {
  if (!/^-?\d+$/.test(String(value).trim())) {
    throw new InvalidArgumentError("Expected a whole number.");
  }
  return Number(value);
}

/** Options shared by generate, plan and load. None has a Commander default, so an
 *  `undefined` value always means "not given" and scenarios can fill it in. */
export function addGenerationOptions(command) {
  return command
    .option("-t, --template <name>", `industry template (default: ${DEFAULT_TEMPLATE})`)
    .option("-p, --scenario <id>", "scenario, e.g. quick-demo, rapid-growth, cash-crisis")
    .option(
      "-m, --months <n>",
      "period length in full calendar months (default: 12, or the scenario's own length)",
      wholeNumber(1, 120)
    )
    .option("-s, --start-date <date>", "first day of the period (YYYY-MM-DD)", isoDate)
    .option("-e, --end-date <date>", "last day of the period (YYYY-MM-DD)", isoDate)
    .option(
      "-r, --revenue <amount>",
      "total revenue for the period, e.g. 750000, 500k, 1.5M",
      amount
    )
    .option("--profit <amount>", "target profit for the period; may be negative, e.g. -50k", amount)
    .option("-c, --customers <n>", "number of customers (1-300)", wholeNumber(1, 300))
    .option("--top-customers <n>", "number of top customers", wholeNumber(1, 300))
    .option("--concentration <percent>", "revenue share of the top customers (1-99)", percent)
    .option("--employees <n>", "number of employees (0-50)", wholeNumber(0, 50))
    .option("--benefits", "include health and dental benefits in payroll")
    .option("--no-benefits", "exclude benefits even if the scenario includes them")
    .option("--country <code>", `locale: ${SUPPORTED_COUNTRIES.join(", ")} (default: US)`, country)
    .option("--tag <tag>", "marker written on generated records for purge (default: EZTD)")
    .option("--seed <n>", "random seed; same seed + same dates = identical output", seed)
    .option("--ratio <key=value...>", "override ratios, e.g. --ratio invoicePaymentRate=0.7");
}

export const GENERATION_HELP = `
The default period is the 12 full calendar months before today, so the data shows up in
QBO's "last 12 months" reports. Because that is relative to today, pass --start-date
(and --months or --end-date) for fully reproducible fixtures.

Precedence: explicit flag > --scenario > .easytestdata.json defaults > built-in default.
Without --seed a random seed is drawn and printed; pass it back to get the same data again.`;

const FLAG_NAMES = {
  totalRevenue: "--revenue",
  targetEbitda: "--profit",
  customerCount: "--customers",
  topCustomerCount: "--top-customers",
  clientConcentrationPercent: "--concentration",
  employeeCount: "--employees",
  startDate: "--start-date",
  endDate: "--end-date"
};

/** Rewrite core field names (customerCount) into CLI flag names (--customers). */
export function toFlagLanguage(message) {
  return String(message)
    .replace(
      /\b(totalRevenue|targetEbitda|customerCount|topCustomerCount|clientConcentrationPercent|employeeCount|startDate|endDate)\b/g,
      (m) => FLAG_NAMES[m]
    )
    .replace(/^months\b/, "--months")
    .replace(/ and months\./, " and --months.")
    .replace("Unknown scenario preset", "Unknown scenario")
    .replace("Valid presets:", "Valid scenarios:");
}

function defined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, v]) => v !== undefined && v !== null)
  );
}

/**
 * Turn parsed CLI options (+ optional .easytestdata.json) into a plan via core generate().
 * Returns { plan, template, preset, seedGiven } where seedGiven says whether the seed came from
 * a flag or the config file (otherwise core drew a random one, recorded in plan.meta.seed).
 */
export function planFromOptions(opts, fileConfig = {}) {
  const defaults = fileConfig.defaults || {};
  const template = opts.template || defaults.template || DEFAULT_TEMPLATE;
  requireIndustryTemplate(template);
  const preset = opts.scenario || defaults.scenario || undefined;
  if (preset) {
    try {
      requireScenarioPreset(preset);
    } catch (err) {
      throw new Error(toFlagLanguage(err.message), { cause: err });
    }
  }

  const flagValues = defined({
    totalRevenue: opts.revenue,
    targetEbitda: opts.profit,
    customerCount: opts.customers,
    topCustomerCount: opts.topCustomers,
    clientConcentrationPercent: opts.concentration,
    employeeCount: opts.employees,
    includeBenefits: opts.benefits,
    tag: opts.tag,
    country: opts.country
  });

  // Config-file defaults sit below the preset: only use them for fields the preset leaves open.
  const presetKeys = new Set(Object.keys(getScenarioPreset(preset)?.request || {}));
  const fileValues = Object.fromEntries(
    Object.entries(
      defined({
        totalRevenue: defaults.revenue,
        targetEbitda: defaults.profit,
        customerCount: defaults.customers,
        topCustomerCount: defaults.topCustomers,
        clientConcentrationPercent: defaults.concentration,
        employeeCount: defaults.employees,
        includeBenefits: defaults.benefits,
        tag: defaults.tag,
        country: defaults.country
      })
    ).filter(([key]) => !presetKeys.has(key))
  );

  const flagPeriod = defined({
    startDate: opts.startDate,
    endDate: opts.endDate,
    months: opts.months
  });
  // Per field: a flag anchor (start or end date) replaces the file's anchor, and the length comes
  // from flags (--months, or both dates), else the scenario's own length (quick-demo = 3
  // months), else the file (its months, or both of its dates).
  const presetSetsLength = getScenarioPreset(preset)?.months != null;
  const period = { ...flagPeriod };
  const flagAnchor = Boolean(period.startDate || period.endDate);
  const flagLength = period.months != null || Boolean(period.startDate && period.endDate);
  if (!flagAnchor) {
    if (defaults.startDate) period.startDate = defaults.startDate;
    else if (defaults.endDate) period.endDate = defaults.endDate;
  }
  if (!flagLength && !presetSetsLength) {
    if (defaults.months != null) period.months = defaults.months;
    else if (!flagAnchor && defaults.startDate && defaults.endDate) {
      period.endDate = defaults.endDate;
    }
  }

  try {
    const seed = opts.seed ?? defaults.seed;
    const plan = generate({
      template,
      preset,
      ...fileValues,
      ...flagValues,
      ...period,
      seed,
      ratios: parseRatioFlags(opts.ratio) || undefined
    });
    return { plan, template, preset, seedGiven: seed != null };
  } catch (err) {
    throw new Error(toFlagLanguage(err.message), { cause: err });
  }
}

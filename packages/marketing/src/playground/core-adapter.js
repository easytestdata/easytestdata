/**
 * Thin adapter between the marketing site and @easytestdata/core.
 *
 * Every call into core goes through this file, so a change in core's public API is a one-file
 * change here.
 * It is imported by the browser bundles (bundled with esbuild in build.js) and by
 * build.js itself to pre-render real numbers into static pages.
 *
 * Only pure, browser-safe core modules are reachable from core's index.js; the
 * Node-only templates/validate-cli.js is never imported.
 */
import * as core from "../../../core/src/index.js";

export const DEFAULTS = {
  template: "saas",
  preset: "rapid-growth",
  seed: 42,
  months: 12
};

export const MONTH_OPTIONS = [6, 12, 24];

export function listTemplates() {
  return core.listIndustryTemplates().map(({ id, name }) => ({ id, name }));
}

export function listPresets() {
  return core.listScenarioPresets().map(({ id, name }) => ({ id, name }));
}

/** Resolved template details (service items, expense categories, key ratios). */
export function describeTemplate(id) {
  const template = core.getIndustryTemplate(id);
  const config = core.resolveConfig(template, {});
  return {
    id,
    name: template.name,
    serviceItems: config.serviceItems.map((s) => s.suffix.replace(/-/g, " ")),
    expenseCategories: config.expenseCategories.map((c) => c.name),
    ratios: config.ratios
  };
}

/** Preset details: the parameters it sets. */
export function describePreset(id) {
  const preset = core.getScenarioPreset(id);
  return {
    id,
    name: preset.name,
    description: preset.description,
    request: preset.request,
    ratioOverrides: preset.ratioOverrides || {}
  };
}

/** Generate a plan exactly the way the CLI does, through core's `generate()`. */
export function generatePlan({ template, preset, seed, months, today } = {}) {
  const numericSeed = Number.isFinite(Number(seed)) ? Math.trunc(Number(seed)) : DEFAULTS.seed;
  return core.generate({
    template: template || DEFAULTS.template,
    preset: preset && preset !== "none" ? preset : undefined,
    seed: numericSeed,
    months: months || DEFAULTS.months,
    today
  });
}

/** A customer's, vendor's or employee's display name. */
export function partyName(party) {
  return party?.name ?? "";
}

export function planToJson(plan) {
  return core.exportToJson(plan);
}

/** @returns {Record<string, string>} one CSV document per entity type */
export function planToCsv(plan) {
  return core.exportToCsv(plan);
}

/** Equivalent CLI command for the given parameters. */
export function cliCommand(verb, { template, preset, seed, months }) {
  const parts = [`npx easytestdata ${verb}`, `--template ${template}`];
  if (preset && preset !== "none") parts.push(`--scenario ${preset}`);
  parts.push(`--seed ${seed}`);
  // Only omit --months when the CLI would pick the same length on its own: the scenario's
  // length when it has one (quick-demo = 3), else 12.
  const scenarioMonths =
    preset && preset !== "none" ? core.getScenarioPreset(preset)?.months : undefined;
  const cliDefault = scenarioMonths ?? DEFAULTS.months;
  if (months && Number(months) !== cliDefault) parts.push(`--months ${months}`);
  return parts.join(" ");
}

import { SCENARIO_PRESETS } from "./data.js";

export const scenarioPresets = SCENARIO_PRESETS;

export function getScenarioPreset(id) {
  return Object.hasOwn(scenarioPresets, id) ? scenarioPresets[id] : null;
}

/** Like getScenarioPreset, but throws a helpful error listing valid ids. */
export function requireScenarioPreset(id) {
  const preset = getScenarioPreset(id);
  if (!preset) {
    throw new Error(
      `Unknown scenario preset "${id}". Valid presets: ${Object.keys(scenarioPresets).join(", ")}`
    );
  }
  return preset;
}

export function listScenarioPresets() {
  return Object.values(scenarioPresets).map(({ id, name, description }) => ({
    id,
    name,
    description
  }));
}

function definedOnly(object) {
  return Object.fromEntries(Object.entries(object || {}).filter(([, v]) => v !== undefined));
}

/**
 * Layer a scenario preset under an explicit request.
 *
 * Precedence: explicit request fields (anything not `undefined`) > preset > caller defaults.
 * Callers must therefore pass only the values the user actually chose, and apply their
 * own defaults afterwards (or use `generate()`, which does this for you).
 *
 * A falsy `presetId` means "no preset". Unknown preset ids throw.
 */
export function applyScenarioPreset(request, presetId) {
  const explicit = definedOnly(request);
  if (!presetId) {
    return { request: explicit, ratioOverrides: { ...(explicit.ratioOverrides || {}) } };
  }
  const preset = requireScenarioPreset(presetId);
  return {
    request: { ...preset.request, ...explicit },
    ratioOverrides: { ...(preset.ratioOverrides || {}), ...(explicit.ratioOverrides || {}) }
  };
}

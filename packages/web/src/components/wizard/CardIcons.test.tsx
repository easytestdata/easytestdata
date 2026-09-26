import { describe, expect, it } from "vitest";
import { industryTemplates, scenarioPresets } from "@easytestdata/core";
import { TEMPLATE_ICONS, PRESET_ICONS, orderScenarios } from "@easytestdata/ui";

// Every card gets its own icon: the maps are keyed by the real ids in @easytestdata/core, so a
// new industry or scenario without an icon (or a renamed id) fails here instead of silently
// showing the fallback icon on every card.
describe("card icons", () => {
  it("has an icon for every industry template id", () => {
    const ids = Object.keys(industryTemplates);
    expect(ids.length).toBeGreaterThan(0);
    const missing = ids.filter((id) => !TEMPLATE_ICONS[id]);
    expect(missing).toEqual([]);
    expect(Object.keys(TEMPLATE_ICONS).filter((id) => !industryTemplates[id])).toEqual([]);
  });

  it("has an icon for every scenario id", () => {
    const ids = Object.keys(scenarioPresets);
    expect(ids.length).toBeGreaterThan(0);
    const missing = ids.filter((id) => !PRESET_ICONS[id]);
    expect(missing).toEqual([]);
    expect(Object.keys(PRESET_ICONS).filter((id) => !scenarioPresets[id])).toEqual([]);
  });

  it("lists the quick demo first while the registry keeps healthy-small first", () => {
    const ids = Object.keys(scenarioPresets);
    expect(ids[0]).toBe("healthy-small");
    expect(orderScenarios(Object.values(scenarioPresets))[0]?.id).toBe("quick-demo");
  });
});

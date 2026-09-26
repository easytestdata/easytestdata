import { Router } from "express";
import {
  listIndustryTemplates,
  getIndustryTemplate,
  getScenarioPreset,
  scenarioPresets
} from "@easytestdata/core";

export function templateRoutes() {
  const router = Router();

  router.get("/industries", (req, res) => {
    res.json(listIndustryTemplates());
  });

  router.get("/industries/:id", (req, res) => {
    const template = getIndustryTemplate(req.params.id);
    if (!template) {
      return res.status(404).json({ error: "Template not found" });
    }
    return res.json({ id: req.params.id, ...template });
  });

  // Full preset objects (request sizes, ratio overrides, suggested months) so the UI can show
  // what each scenario means and apply it without a second request.
  router.get("/presets", (req, res) => {
    res.json(Object.values(scenarioPresets));
  });

  router.get("/presets/:id", (req, res) => {
    const preset = getScenarioPreset(req.params.id);
    if (!preset) {
      return res.status(404).json({ error: "Preset not found" });
    }
    return res.json(preset);
  });

  return router;
}

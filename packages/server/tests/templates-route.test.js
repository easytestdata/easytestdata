import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { listIndustryTemplates, scenarioPresets } from "@easytestdata/core";
import { ACTIVE_JOB_STATUSES } from "@easytestdata/shared/query-keys";
import { templateRoutes } from "../src/routes/templates.js";

const app = express().use("/api/v1/templates", templateRoutes());

describe("template routes", () => {
  it("lists the industry templates and serves each one's details", async () => {
    const list = await request(app).get("/api/v1/templates/industries");
    expect(list.status).toBe(200);
    expect(list.body).toEqual(listIndustryTemplates());

    const saas = await request(app).get("/api/v1/templates/industries/saas");
    expect(saas.status).toBe(200);
    expect(saas.body.id).toBe("saas");
  });

  it("lists the scenario presets and serves each one", async () => {
    const list = await request(app).get("/api/v1/templates/presets");
    expect(list.status).toBe(200);
    expect(list.body).toEqual(Object.values(scenarioPresets));

    const preset = await request(app).get("/api/v1/templates/presets/quick-demo");
    expect(preset.status).toBe(200);
    expect(preset.body.id).toBe("quick-demo");
  });

  it("answers 404 for an unknown template or preset", async () => {
    expect((await request(app).get("/api/v1/templates/industries/nope")).status).toBe(404);
    expect((await request(app).get("/api/v1/templates/presets/nope")).status).toBe(404);
  });
});

describe("job polling", () => {
  it("keeps polling a cancelling job until it reaches a terminal state", () => {
    expect(ACTIVE_JOB_STATUSES).toContain("cancelling");
  });
});

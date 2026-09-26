import express from "express";
import request from "supertest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";

// The artifact directory is read when job-artifacts.js is imported, so set it before any import.
const mocks = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "etd-artifacts-"));
  process.env.JOB_ARTIFACTS_DIR = dir;
  return { dir, query: vi.fn() };
});

vi.mock("../src/middleware/auth.js", () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: "user-1", teamId: "team-1", role: "owner" };
    next();
  }
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args) => mocks.query(...args)
}));

vi.mock("../src/workers/runner.js", () => ({ notifyJobQueued: vi.fn() }));

import {
  buildCsvArtifactZip,
  resolveArtifactPath,
  selectArtifact,
  writeJobArtifacts
} from "../src/services/job-artifacts.js";
import { buildPlanFromScenario, normalizeScenarioConfig } from "../src/services/scenario-config.js";
import { jobRoutes } from "../src/routes/jobs.js";

afterAll(() => {
  rmSync(mocks.dir, { recursive: true, force: true });
});

let cachedPlan;
function samplePlan() {
  cachedPlan ??= buildPlanFromScenario(
    normalizeScenarioConfig({
      templateId: "professional-services",
      startDate: "2024-01-01",
      endDate: "2024-03-31",
      totalRevenue: 100000,
      customerCount: 3,
      employeeCount: 1
    })
  ).plan;
  return cachedPlan;
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", jobRoutes());
  app.use((err, _req, res, _next) => {
    res.status(err.status || err.statusCode || 500).json({ error: err.message });
  });
  return app;
}

describe("scenario config for offline generation", () => {
  it("accepts a scenario without a QBO connection", () => {
    const cfg = normalizeScenarioConfig({ templateId: "saas" });
    expect(cfg.connectionId).toBeUndefined();
    expect(cfg.exportFormat).toBe("json");
  });

  it("keeps the requested export format", () => {
    expect(normalizeScenarioConfig({ templateId: "saas", exportFormat: "csv" }).exportFormat).toBe(
      "csv"
    );
    expect(normalizeScenarioConfig({ templateId: "saas", exportFormat: "xml" }).exportFormat).toBe(
      "json"
    );
  });
});

describe("job artifacts", () => {
  it("zips one spreadsheet-ready CSV per record type", () => {
    const files = unzipSync(buildCsvArtifactZip(samplePlan()));
    expect(Object.keys(files)).toContain("customers.csv");
    const customers = strFromU8(files["customers.csv"]);
    expect(customers.startsWith("id,")).toBe(true);
    expect(customers).not.toContain("###");
  });

  it("writes JSON and CSV files and marks the requested format as primary", async () => {
    const { artifact, artifacts } = await writeJobArtifacts("job-csv", samplePlan(), "csv");
    expect(artifact.format).toBe("csv");
    expect(artifacts.json.filename).toBe("job-csv.json");
    expect(artifacts.csv.filename).toBe("job-csv-csv.zip");
    // Descriptors are sent to clients, so they must not leak the server's file paths.
    expect(artifacts.json).not.toHaveProperty("filePath");
    expect(JSON.stringify(artifacts)).not.toContain(process.env.JOB_ARTIFACTS_DIR);
    const jsonPath = await resolveArtifactPath(artifacts.json);
    const csvPath = await resolveArtifactPath(artifacts.csv);
    expect(() => JSON.parse(readFileSync(jsonPath, "utf8"))).not.toThrow();
    expect(Object.keys(unzipSync(readFileSync(csvPath)))).toContain("invoices.csv");
  });

  it("stops on an aborted signal and removes the job's partly written files", async () => {
    const leftover = path.join(mocks.dir, "job-abort.json");
    const other = path.join(mocks.dir, "job-other.json");
    writeFileSync(leftover, "{ partial");
    writeFileSync(other, "{}");
    const controller = new AbortController();
    const reason = new Error("Job timed out");
    const writing = writeJobArtifacts("job-abort", samplePlan(), "json", {
      signal: controller.signal
    });
    controller.abort(reason);
    await expect(writing).rejects.toBe(reason);
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(path.join(mocks.dir, "job-abort-csv.zip"))).toBe(false);
    // Another job's files are left alone.
    expect(existsSync(other)).toBe(true);
  });

  it("selects artifacts by format, falling back to a matching primary artifact", () => {
    const json = { filename: "a.json", format: "json" };
    const csv = { filename: "a.csv", format: "csv" };
    expect(selectArtifact({ artifact: csv, artifacts: { json, csv } }, "json")).toBe(json);
    expect(selectArtifact({ artifact: csv, artifacts: { json, csv } })).toBe(csv);
    expect(selectArtifact({ artifact: json }, "json")).toBe(json);
    expect(selectArtifact({ artifact: json }, "csv")).toBeNull();
    expect(selectArtifact({ artifact: json }, "../etc")).toBeNull();
    expect(selectArtifact(null, "json")).toBeNull();
  });
});

describe("GET /jobs/:id/download", () => {
  let stored;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { artifact, artifacts } = await writeJobArtifacts("job-dl", samplePlan(), "csv");
    stored = { artifact, artifacts };
    mocks.query.mockImplementation((sql) => {
      if (sql.includes("FROM jobs WHERE id = $1 AND team_id = $2")) {
        return Promise.resolve({ rows: [{ id: "job-dl", result: JSON.stringify(stored) }] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it("downloads the CSV file when format=csv", async () => {
    const res = await request(makeApp()).get("/api/jobs/job-dl/download?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("job-dl-csv.zip");
    expect(res.headers["content-type"]).toContain("application/zip");
  });

  it("downloads the JSON file when format=json", async () => {
    const res = await request(makeApp()).get("/api/jobs/job-dl/download?format=json");
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("job-dl.json");
  });

  it("returns 404 for a format the job does not have", async () => {
    stored = { artifact: stored.artifacts.json };
    const res = await request(makeApp()).get("/api/jobs/job-dl/download?format=csv");
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("CSV");
  });

  it("serves the JSON preview even when the primary artifact is CSV", async () => {
    const res = await request(makeApp()).get("/api/jobs/job-dl/data");
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe("object");
  });
});

describe("POST /jobs without a connection", () => {
  it("rejects load jobs that name no QBO connection", async () => {
    mocks.query.mockResolvedValue({ rows: [] });

    const res = await request(makeApp())
      .post("/api/jobs")
      .send({ type: "load", templateId: "saas", config: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Connect a QuickBooks sandbox");
  });
});

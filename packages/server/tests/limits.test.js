import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEPLOYMENT_LIMITS, limitExceededMessage } from "@easytestdata/shared/constants";

const queryMock = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args) => queryMock(...args)
}));

import { config } from "../src/config.js";
import {
  enforceJobCreationLimits,
  enforceWorkerExecutionLimits,
  getDeployment,
  getLimits,
  limitExceededError
} from "../src/services/limits.js";

const originalDeployment = config.deployment;

afterEach(() => {
  config.deployment = originalDeployment;
});

describe("deployment limits", () => {
  it("applies the Cloud abuse limits on EasyTestData Cloud", () => {
    config.deployment = "cloud";
    expect(getDeployment()).toBe("cloud");
    expect(getLimits()).toEqual({
      connections: 3,
      loadsPerMonth: 10,
      entitiesPerJob: 5000,
      teamMembers: 5
    });
  });

  it("has no limits in local mode", () => {
    config.deployment = "local";
    expect(getDeployment()).toBe("local");
    expect(Object.values(getLimits()).every((limit) => limit === -1)).toBe(true);
    expect(getLimits()).toBe(DEPLOYMENT_LIMITS.local);
  });

  it("explains every limit in plain words and points at local mode", () => {
    expect(limitExceededMessage("entitiesPerJob", 5000)).toBe(
      "EasyTestData Cloud allows up to 5,000 records per job. Run it locally for no limits."
    );
    expect(limitExceededMessage("loadsPerMonth", 10)).toBe(
      "EasyTestData Cloud allows up to 10 loads into QuickBooks per month. Run it locally for no limits."
    );
    expect(limitExceededMessage("connections", 3)).toBe(
      "EasyTestData Cloud allows up to 3 QuickBooks connections per team. Run it locally for no limits."
    );
    expect(limitExceededMessage("teamMembers", 5)).toBe(
      "EasyTestData Cloud allows up to 5 members per team. Run it locally for no limits."
    );
  });

  it("builds a 403 with a LIMIT_EXCEEDED code", () => {
    const err = limitExceededError("teamMembers", 5);
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("LIMIT_EXCEEDED");
  });
});

describe("getMonthlyUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts this month's loads the way the limit does, and completed jobs' records", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ loads: 3, entities: 1200 }] });
    const { getMonthlyUsage } = await import("../src/services/limits.js");
    expect(await getMonthlyUsage("t1")).toEqual({ loads: 3, entities: 1200 });
    const sql = queryMock.mock.calls[0][0];
    expect(sql).toMatch(/COUNT\(\*\) FILTER \(WHERE type = 'load'\)/);
    expect(sql).toMatch(/SUM\(entity_count\) FILTER \(WHERE status = 'completed'\)/);
  });
});

describe("enforceJobCreationLimits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a Cloud job above the per-job record limit with the standard message", async () => {
    config.deployment = "cloud";
    await expect(enforceJobCreationLimits("team-1", 5001)).rejects.toMatchObject({
      statusCode: 403,
      message:
        "EasyTestData Cloud allows up to 5,000 records per job. Run it locally for no limits."
    });
  });

  it("returns the deployment and limits when within limits, without querying usage", async () => {
    config.deployment = "cloud";
    const result = await enforceJobCreationLimits("team-1", 5000);
    expect(result).toEqual({ deployment: "cloud", limits: expect.any(Object) });
    expect(result.limits.entitiesPerJob).toBe(5000);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("allows any size in local mode", async () => {
    config.deployment = "local";
    const result = await enforceJobCreationLimits("team-1", 10_000_000);
    expect(result.deployment).toBe("local");
  });
});

describe("enforceWorkerExecutionLimits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a load whose monthly load rank exceeds the Cloud limit", async () => {
    config.deployment = "cloud";
    queryMock.mockImplementation((sql) => {
      if (sql.includes("WITH target_job AS")) {
        expect(sql).toContain("j.type = 'load'");
        return Promise.resolve({ rows: [{ job_rank: 11 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      enforceWorkerExecutionLimits({
        teamId: "team-1",
        jobId: "job-1",
        type: "load",
        estimatedEntities: 10
      })
    ).rejects.toThrow(
      "EasyTestData Cloud allows up to 10 loads into QuickBooks per month. Run it locally for no limits."
    );
  });

  it("never counts a purge, roll back or download against the load limit", async () => {
    config.deployment = "cloud";
    for (const type of ["purge", "rollback", "generate"]) {
      await enforceWorkerExecutionLimits({ teamId: "team-1", jobId: "job-x", type });
    }
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized job before counting monthly usage", async () => {
    config.deployment = "cloud";
    await expect(
      enforceWorkerExecutionLimits({ teamId: "team-1", jobId: "job-2", estimatedEntities: 9999 })
    ).rejects.toThrow(/5,000 records per job/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("allows valid execution when limits are satisfied", async () => {
    config.deployment = "cloud";
    queryMock.mockImplementation((sql) => {
      if (sql.includes("WITH target_job AS")) {
        return Promise.resolve({ rows: [{ job_rank: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await enforceWorkerExecutionLimits({
      teamId: "team-1",
      jobId: "job-3",
      type: "load",
      estimatedEntities: 10
    });

    expect(result.deployment).toBe("cloud");
    expect(result.limits.loadsPerMonth).toBe(10);
  });

  it("skips the monthly count entirely in local mode", async () => {
    config.deployment = "local";
    const result = await enforceWorkerExecutionLimits({
      teamId: "team-1",
      jobId: "job-4",
      estimatedEntities: 50_000
    });
    expect(result.deployment).toBe("local");
    expect(queryMock).not.toHaveBeenCalled();
  });
});

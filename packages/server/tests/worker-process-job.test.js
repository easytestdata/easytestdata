import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
// Intuit app keys come from the environment (Cloud mode in tests).
vi.stubEnv("QBO_CLIENT_ID", "client-id");
vi.stubEnv("QBO_CLIENT_SECRET", "client-secret");
const enforceWorkerExecutionLimitsMock = vi.fn();
const writeJobArtifactMock = vi.fn();
const writeJobArtifactsMock = vi.fn();
const loadPlanIntoQboMock = vi.fn();
const cleanupExpiredArtifactsMock = vi.fn();
const removeJobArtifactsMock = vi.fn();

// Hoisted so tests can assert the order of lock-acquire vs. connection SELECT, and that the
// lock is released.
const { orderLog, acquireLockMock, releaseLockMock } = vi.hoisted(() => {
  const orderLog = [];
  return {
    orderLog,
    acquireLockMock: vi.fn(async (connectionId) => {
      orderLog.push("lock");
      return { connectionId, token: "t" };
    }),
    releaseLockMock: vi.fn(async () => {})
  };
});

// Transactions run their statements through the same mock (as a client), in order.
vi.mock("../src/db/pool.js", async () => {
  const { fakeTransaction } = await import("./fake-transaction.js");
  const { transaction, rollback } = fakeTransaction(() => ({
    query: (...args) => queryMock(...args)
  }));
  return { query: (...args) => queryMock(...args), transaction, rollback };
});

vi.mock("../src/services/limits.js", () => ({
  enforceWorkerExecutionLimits: (...args) => enforceWorkerExecutionLimitsMock(...args)
}));

vi.mock("../src/services/scenario-config.js", () => ({
  normalizeScenarioConfig: vi.fn(() => ({
    connectionId: "11111111-1111-1111-1111-111111111111",
    templateId: "saas",
    exportFormat: "json",
    tag: "EZTD"
  })),
  buildPlanFromScenario: vi.fn(() => ({
    plan: {
      metrics: {
        customerCount: 2,
        vendorCount: 1,
        employeeCount: 1
      }
    },
    resolvedConfig: {}
  })),
  countPlanEntities: vi.fn(() => 4)
}));

vi.mock("../src/services/job-artifacts.js", () => ({
  writeJobArtifact: (...args) => writeJobArtifactMock(...args),
  writeJobArtifacts: (...args) => writeJobArtifactsMock(...args),
  cleanupExpiredArtifacts: (...args) => cleanupExpiredArtifactsMock(...args),
  removeJobArtifacts: (...args) => removeJobArtifactsMock(...args)
}));

vi.mock("../src/crypto/tokens.js", () => ({
  decryptTokenPair: () => ({
    accessToken: "access-token",
    refreshToken: "refresh-token"
  }),
  encryptTokenPair: () => ({
    access_token_enc: "enc-access",
    refresh_token_enc: "enc-refresh",
    token_iv: "enc-iv"
  })
}));

vi.mock("@easytestdata/qbo-client", () => ({
  QboClient: vi.fn(),
  loadPlanIntoQbo: (...args) => loadPlanIntoQboMock(...args),
  purgeTransactions: vi.fn(),
  rollbackLoad: vi.fn().mockResolvedValue({ totalDeleted: 0 })
}));

vi.mock("../src/services/connection-lock.js", async (importOriginal) => ({
  ...(await importOriginal()),
  acquireConnectionLock: (...args) => acquireLockMock(...args),
  releaseConnectionLock: (...args) => releaseLockMock(...args)
}));

// Timeout tests deliberately outlive the grace period; keep their error logs out of the output.
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { purgeTransactions, rollbackLoad } from "@easytestdata/qbo-client";
import { normalizeScenarioConfig } from "../src/services/scenario-config.js";
import {
  abortAndDrainJobs,
  abortRunningJob,
  JobForceFailedError,
  JobShutdownError,
  processJob
} from "../src/workers/index.js";

describe("processJob usage-limit handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orderLog.length = 0;
    loadPlanIntoQboMock.mockReset();
    writeJobArtifactMock.mockReturnValue({
      filename: "job.json",
      mimeType: "application/json",
      format: "json"
    });
    writeJobArtifactsMock.mockImplementation((jobId, _plan, format) => {
      const artifacts = {
        json: { filename: `${jobId}.json`, mimeType: "application/json", format: "json" },
        csv: { filename: `${jobId}-csv.zip`, mimeType: "application/zip", format: "csv" }
      };
      return { artifact: artifacts[format === "csv" ? "csv" : "json"], artifacts };
    });
  });

  it("fails and returns early when worker-time usage check fails", async () => {
    const job = {
      id: "job-1",
      team_id: "team-1",
      status: "pending",
      type: "generate",
      connection_id: null,
      config: {}
    };

    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) {
        return Promise.resolve({ rows: [job] });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    enforceWorkerExecutionLimitsMock.mockRejectedValue(new Error("Monthly job limit exceeded."));

    await expect(processJob({ jobId: job.id, kind: "local" })).resolves.toBeUndefined();

    expect(
      queryMock.mock.calls.some(([sql]) => String(sql).includes("SET status = 'failed'"))
    ).toBe(true);
    expect(writeJobArtifactMock).not.toHaveBeenCalled();
    expect(writeJobArtifactsMock).not.toHaveBeenCalled();
  });

  it("completes generate jobs when worker-time usage check passes", async () => {
    const job = {
      id: "job-2",
      team_id: "team-1",
      status: "pending",
      type: "generate",
      connection_id: null,
      config: {}
    };

    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) {
        return Promise.resolve({ rows: [job] });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    enforceWorkerExecutionLimitsMock.mockResolvedValue({ deployment: "cloud" });

    await expect(processJob({ jobId: job.id, kind: "local" })).resolves.toBeUndefined();

    expect(writeJobArtifactsMock).toHaveBeenCalledTimes(1);
    const completeCall = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes("SET status = 'completed'")
    );
    // Monthly usage is derived from completed jobs' entity_count.
    expect(completeCall[1][1]).toBe(4);
    const stored = JSON.parse(completeCall[1][0]);
    expect(stored.artifact.format).toBe("json");
    expect(Object.keys(stored.artifacts).sort()).toEqual(["csv", "json"]);
  });

  it("fails a generate job at its timeout while the files are still being written", async () => {
    const job = {
      id: "job-slow-fs",
      team_id: "team-1",
      status: "pending",
      type: "generate",
      connection_id: null,
      config: {}
    };
    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) {
        return Promise.resolve({ rows: [job] });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    enforceWorkerExecutionLimitsMock.mockResolvedValue({ deployment: "cloud" });
    // A stalled disk: the write would finish well inside the grace period, but it stops (and
    // cleans up, which the writer's own test covers) as soon as the job's signal aborts.
    writeJobArtifactsMock.mockImplementation(
      (_jobId, _plan, _format, { signal } = {}) =>
        new Promise((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
          setTimeout(() => resolve({ artifact: null, artifacts: {} }), 40);
        })
    );

    await processJob({ jobId: job.id, kind: "local" }, { timeoutMs: 10, timeoutGraceMs: 1000 });

    const sqls = queryMock.mock.calls.map(([sql]) => String(sql));
    expect(sqls.some((sql) => sql.includes("SET status = 'completed'"))).toBe(false);
    const failed = queryMock.mock.calls.find(([sql]) => String(sql).includes("SET status = $1"));
    expect(failed[1].slice(0, 2)).toEqual(["failed", expect.stringContaining("timed out")]);
  });

  describe("without Intuit app keys", () => {
    beforeEach(() => vi.stubEnv("QBO_CLIENT_ID", ""));
    afterEach(() => vi.stubEnv("QBO_CLIENT_ID", "client-id"));

    function mockJob(job) {
      queryMock.mockImplementation((sql) => {
        if (sql.includes("SELECT * FROM jobs WHERE id = $1")) {
          return Promise.resolve({ rows: [job] });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });
      enforceWorkerExecutionLimitsMock.mockResolvedValue({ deployment: "cloud" });
    }

    it("still generates files", async () => {
      mockJob({
        id: "job-nk1",
        team_id: "team-1",
        status: "pending",
        type: "generate",
        config: {}
      });
      await processJob({ jobId: "job-nk1", kind: "local" });
      expect(writeJobArtifactsMock).toHaveBeenCalledTimes(1);
      expect(queryMock.mock.calls.some(([sql]) => sql.includes("SET status = 'completed'"))).toBe(
        true
      );
    });

    it("fails a load with the setup hint before taking the lock or touching QBO", async () => {
      mockJob({
        id: "job-nk2",
        team_id: "team-1",
        status: "pending",
        type: "load",
        connection_id: "11111111-1111-1111-1111-111111111111",
        config: {}
      });
      await expect(processJob({ jobId: "job-nk2", kind: "qbo" })).rejects.toMatchObject({
        code: "QBO_NOT_CONFIGURED"
      });
      const failed = queryMock.mock.calls.find(([sql]) => sql.includes("SET status = $1"));
      expect(failed[1].slice(0, 2)).toEqual([
        "failed",
        expect.stringMatching(/QuickBooks Online is not configured/)
      ]);
      expect(acquireLockMock).not.toHaveBeenCalled();
      expect(loadPlanIntoQboMock).not.toHaveBeenCalled();
    });
  });

  it.each(["load", "rollback"])(
    "fails a %s on a disconnected sandbox with the reconnect hint, before touching QBO",
    async (type) => {
      const job = {
        id: `job-disc-${type}`,
        team_id: "team-1",
        status: "pending",
        type,
        connection_id: "11111111-1111-1111-1111-111111111111",
        parent_job_id: type === "rollback" ? "parent-d" : null,
        config: {}
      };
      queryMock.mockImplementation((sql) => {
        if (sql.includes("SELECT * FROM jobs WHERE id = $1 AND team_id = $2")) {
          return Promise.resolve({
            rows: [
              {
                id: "parent-d",
                team_id: "team-1",
                connection_id: job.connection_id,
                result: { ledger: {} }
              }
            ]
          });
        }
        if (sql.includes("SELECT * FROM jobs WHERE id = $1"))
          return Promise.resolve({ rows: [job] });
        if (sql.includes("SELECT * FROM qbo_connections")) {
          return Promise.resolve({
            rows: [
              {
                id: job.connection_id,
                realm_id: "realm-1",
                access_token_enc: null,
                refresh_token_enc: null,
                token_iv: null,
                disconnected_at: "2026-09-01T00:00:00.000Z"
              }
            ]
          });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });
      enforceWorkerExecutionLimitsMock.mockResolvedValue({ deployment: "cloud" });

      await processJob({ jobId: job.id, kind: "qbo" }).catch(() => {});

      const failed = queryMock.mock.calls.find(
        ([sql, params]) => String(sql).includes("SET status =") && params?.[0] === "failed"
      );
      expect(failed?.[1][1]).toMatch(/disconnected\. Reconnect it/);
      expect(loadPlanIntoQboMock).not.toHaveBeenCalled();
      expect(rollbackLoad).not.toHaveBeenCalled();
      expect(releaseLockMock).toHaveBeenCalled();
    }
  );

  it("preserves failed_with_orphans status and records the failure once when load fails with ledger", async () => {
    const job = {
      id: "job-3",
      team_id: "team-1",
      status: "pending",
      type: "load",
      connection_id: "11111111-1111-1111-1111-111111111111",
      config: {}
    };

    const failingError = new Error("QBO load failed");
    failingError.ledger = { totalTracked: 3, transactions: [{ type: "Invoice", id: "1" }] };
    loadPlanIntoQboMock.mockRejectedValue(failingError);

    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) {
        return Promise.resolve({ rows: [job] });
      }
      if (sql.includes("SELECT * FROM qbo_connections WHERE id = $1 AND team_id = $2")) {
        return Promise.resolve({
          rows: [
            {
              id: job.connection_id,
              realm_id: "realm-1",
              base_url: "https://sandbox-quickbooks.api.intuit.com",
              access_token_enc: "enc-access",
              refresh_token_enc: "enc-refresh",
              token_iv: "enc-iv"
            }
          ]
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    enforceWorkerExecutionLimitsMock.mockResolvedValue({ deployment: "cloud" });

    await expect(processJob({ jobId: job.id, kind: "qbo" })).resolves.toBeUndefined();

    expect(queryMock).toHaveBeenCalledWith(
      "SELECT * FROM qbo_connections WHERE id = $1 AND team_id = $2",
      [job.connection_id, job.team_id]
    );

    const failedStatusUpdates = queryMock.mock.calls.filter(([sql]) =>
      String(sql).includes("SET status =")
    );
    expect(failedStatusUpdates).toHaveLength(2); // running + failed_with_orphans
    const orphaned = failedStatusUpdates.filter(
      ([sql, params]) =>
        String(sql).includes("status = $1") && params?.[0] === "failed_with_orphans"
    );
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0][1][1]).toBe("QBO load failed");
  });

  it.each([
    ["none", "generated"],
    [undefined, "generated"],
    ["generated", "generated"],
    ["all", "all"]
  ])("runs a purge job for scenario purgeMode %s as mode %s", async (scenarioMode, expected) => {
    const job = {
      id: "job-purge",
      team_id: "team-1",
      status: "pending",
      type: "purge",
      connection_id: "11111111-1111-1111-1111-111111111111",
      config: {}
    };
    normalizeScenarioConfig.mockReturnValueOnce({
      connectionId: job.connection_id,
      templateId: "saas",
      exportFormat: "json",
      tag: "EZTD",
      purgeMode: scenarioMode
    });
    purgeTransactions.mockResolvedValue({ deletedTotal: 0 });
    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) return Promise.resolve({ rows: [job] });
      if (sql.includes("SELECT * FROM qbo_connections WHERE id = $1 AND team_id = $2")) {
        return Promise.resolve({
          rows: [
            {
              id: job.connection_id,
              realm_id: "realm-1",
              base_url: "https://sandbox-quickbooks.api.intuit.com",
              access_token_enc: "enc-access",
              refresh_token_enc: "enc-refresh",
              token_iv: "enc-iv"
            }
          ]
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    enforceWorkerExecutionLimitsMock.mockResolvedValue({ deployment: "cloud" });

    await processJob({ jobId: job.id, kind: "qbo" });

    expect(purgeTransactions).toHaveBeenCalledWith(
      expect.anything(),
      { mode: expected, tag: "EZTD" },
      expect.any(Function),
      expect.anything()
    );
  });

  it.each([
    ["the completion update fails", "artifact ok"],
    ["the artifact write and the completion update fail", "artifact fails"]
  ])(
    "keeps the ledger (failed_with_orphans) when %s after a successful load",
    async (_label, artifactCase) => {
      const job = {
        id: "job-fin",
        team_id: "team-1",
        status: "pending",
        type: "load",
        connection_id: "11111111-1111-1111-1111-111111111111",
        config: {}
      };
      const ledger = { totalTracked: 2, transactions: [{ type: "Invoice", id: "9" }] };
      loadPlanIntoQboMock.mockResolvedValue({ ledger });
      if (artifactCase === "artifact fails") {
        writeJobArtifactMock.mockRejectedValueOnce(new Error("disk full"));
      }
      queryMock.mockImplementation((sql) => {
        if (sql.includes("SELECT * FROM jobs WHERE id = $1"))
          return Promise.resolve({ rows: [job] });
        if (sql.includes("SELECT * FROM qbo_connections WHERE id = $1 AND team_id = $2")) {
          return Promise.resolve({
            rows: [
              {
                id: job.connection_id,
                realm_id: "realm-1",
                base_url: "https://sandbox-quickbooks.api.intuit.com",
                access_token_enc: "enc-access",
                refresh_token_enc: "enc-refresh",
                token_iv: "enc-iv"
              }
            ]
          });
        }
        if (sql.includes("SET status = 'completed'")) {
          return Promise.reject(new Error("connection terminated"));
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });
      enforceWorkerExecutionLimitsMock.mockResolvedValue({ deployment: "cloud" });

      await processJob({ jobId: job.id, kind: "qbo" });

      const orphaned = queryMock.mock.calls.find(
        ([sql, params]) =>
          String(sql).includes("status = $1") && params?.[0] === "failed_with_orphans"
      );
      expect(orphaned).toBeDefined();
      expect(orphaned[1]).toContain(JSON.stringify({ ledger }));
    }
  );

  it("completes a load whose artifact could not be written, and says so", async () => {
    const job = {
      id: "job-noart",
      team_id: "team-1",
      status: "pending",
      type: "load",
      connection_id: "11111111-1111-1111-1111-111111111111",
      config: {}
    };
    loadPlanIntoQboMock.mockResolvedValue({ ledger: { totalTracked: 1, transactions: [] } });
    writeJobArtifactMock.mockRejectedValueOnce(new Error("disk full"));
    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) return Promise.resolve({ rows: [job] });
      if (sql.includes("SELECT * FROM qbo_connections WHERE id = $1 AND team_id = $2")) {
        return Promise.resolve({
          rows: [
            {
              id: job.connection_id,
              realm_id: "realm-1",
              base_url: "https://sandbox-quickbooks.api.intuit.com",
              access_token_enc: "enc-access",
              refresh_token_enc: "enc-refresh",
              token_iv: "enc-iv"
            }
          ]
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    enforceWorkerExecutionLimitsMock.mockResolvedValue({ deployment: "cloud" });

    await processJob({ jobId: job.id, kind: "qbo" });

    const completed = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes("SET status = 'completed'")
    );
    const stored = JSON.parse(completed[1][0]);
    expect(stored.artifact).toBeNull();
    expect(stored.artifactError).toMatch(/could not be saved/);
  });

  it("stops a load's stalled artifact write at the timeout and still completes the load", async () => {
    const job = {
      id: "job-stalled-art",
      team_id: "team-1",
      status: "pending",
      type: "load",
      connection_id: "11111111-1111-1111-1111-111111111111",
      config: {}
    };
    const ledger = { totalTracked: 3, transactions: [] };
    loadPlanIntoQboMock.mockResolvedValue({ ledger });
    // A stalled disk: the write only ends when the job's signal aborts it.
    let finishStalledWrite;
    writeJobArtifactMock.mockImplementationOnce(
      (_jobId, _plan, _format, { signal } = {}) =>
        new Promise((resolve, reject) => {
          finishStalledWrite = () => resolve({ filename: "late.json", format: "json" });
          signal?.addEventListener("abort", () => reject(signal.reason));
        })
    );
    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) return Promise.resolve({ rows: [job] });
      if (sql.includes("SELECT * FROM qbo_connections WHERE id = $1 AND team_id = $2")) {
        return Promise.resolve({
          rows: [
            {
              id: job.connection_id,
              realm_id: "realm-1",
              base_url: "https://sandbox-quickbooks.api.intuit.com",
              access_token_enc: "enc-access",
              refresh_token_enc: "enc-refresh",
              token_iv: "enc-iv",
              connected_at: new Date().toISOString()
            }
          ]
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    enforceWorkerExecutionLimitsMock.mockResolvedValue({ deployment: "cloud" });

    const startedAt = Date.now();
    await processJob({ jobId: job.id, kind: "qbo" }, { timeoutMs: 20, timeoutGraceMs: 1000 });

    // The write stopped at the abort, well inside the grace; the lock was released with it.
    expect(Date.now() - startedAt).toBeLessThan(900);
    expect(releaseLockMock).toHaveBeenCalledTimes(1);
    expect(removeJobArtifactsMock).toHaveBeenCalledWith(job.id);
    // The records exist in QBO, so the load completes with its ledger, without the file.
    const completed = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes("SET status = 'completed'")
    );
    const stored = JSON.parse(completed[1][0]);
    expect(stored.ledger).toEqual(ledger);
    expect(stored.artifact).toBeNull();
    expect(stored.artifactError).toMatch(/not saved/);
    // The timeout's own failed write comes after it and only touches an open row, so the
    // completed load keeps its status.
    const sqls = queryMock.mock.calls.map(([sql]) => String(sql));
    const completedAt = sqls.findIndex((sql) => sql.includes("SET status = 'completed'"));
    const failedAt = sqls.findIndex((sql) => sql.includes("SET status = $1"));
    if (failedAt !== -1) {
      expect(failedAt).toBeGreaterThan(completedAt);
      expect(sqls[failedAt]).toContain("status IN");
    }

    finishStalledWrite?.();
    await abortAndDrainJobs(new JobShutdownError());
  });

  it("acquires the connection lock before reading/building the client in the rollback path", async () => {
    const rollbackJob = {
      id: "job-rb",
      team_id: "team-1",
      status: "pending",
      type: "rollback",
      connection_id: "11111111-1111-1111-1111-111111111111",
      parent_job_id: "parent-1",
      config: {}
    };

    queryMock.mockImplementation((sql) => {
      // Parent-job lookup (team-scoped) — must be checked before the plain job lookup.
      if (sql.includes("SELECT * FROM jobs WHERE id = $1 AND team_id = $2")) {
        return Promise.resolve({
          rows: [
            {
              id: "parent-1",
              team_id: "team-1",
              connection_id: rollbackJob.connection_id,
              result: { ledger: { transactions: [] } }
            }
          ]
        });
      }
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) {
        return Promise.resolve({ rows: [rollbackJob] });
      }
      if (sql.includes("SELECT * FROM qbo_connections")) {
        orderLog.push("select-conn");
        return Promise.resolve({
          rows: [
            {
              id: rollbackJob.connection_id,
              realm_id: "r1",
              base_url: "https://sandbox-quickbooks.api.intuit.com",
              access_token_enc: "enc-access",
              refresh_token_enc: "enc-refresh",
              token_iv: "enc-iv"
            }
          ]
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await expect(processJob({ jobId: rollbackJob.id, kind: "qbo" })).resolves.toBeUndefined();

    // Lock is taken before the connection row is read/built — no stale-token window.
    expect(orderLog).toEqual(["lock", "select-conn"]);
  });

  it("fails a rollback that could not delete everything and keeps the load rollback-eligible", async () => {
    const rollbackJob = {
      id: "job-rb2",
      team_id: "team-1",
      status: "pending",
      type: "rollback",
      connection_id: "11111111-1111-1111-1111-111111111111",
      parent_job_id: "parent-2",
      config: {}
    };
    rollbackLoad.mockResolvedValueOnce({
      totalDeleted: 3,
      deletedByEntity: { Invoice: 3 },
      failures: [{ entityType: "Invoice", id: "7", error: "Business Validation Error" }]
    });
    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1 AND team_id = $2")) {
        return Promise.resolve({
          rows: [
            {
              id: "parent-2",
              team_id: "team-1",
              connection_id: rollbackJob.connection_id,
              result: { ledger: { transactions: [] } }
            }
          ]
        });
      }
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) {
        return Promise.resolve({ rows: [rollbackJob] });
      }
      if (sql.includes("SELECT * FROM qbo_connections")) {
        return Promise.resolve({
          rows: [
            {
              id: rollbackJob.connection_id,
              realm_id: "r1",
              base_url: "https://sandbox-quickbooks.api.intuit.com",
              access_token_enc: "enc-access",
              refresh_token_enc: "enc-refresh",
              token_iv: "enc-iv"
            }
          ]
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await processJob({ jobId: rollbackJob.id, kind: "qbo" });

    const sql = queryMock.mock.calls.map(([q]) => String(q));
    expect(sql.some((q) => q.includes("SET status = 'completed'"))).toBe(false);
    // The parent load is not moved off failed_with_orphans, so it can be rolled back again.
    expect(sql.some((q) => q.includes("SET status = 'failed' WHERE id = $1 AND status"))).toBe(
      false
    );
    const failed = queryMock.mock.calls.find(
      ([q, params]) => String(q).includes("status = $1") && params?.[0] === "failed"
    );
    expect(failed[1][1]).toMatch(/Rolled back 3 records; 1 could not be deleted/);
    expect(JSON.parse(failed[1][2]).failures).toHaveLength(1);
  });

  describe("rollback of an older load", () => {
    const rollbackJob = {
      id: "job-rb4",
      team_id: "team-1",
      status: "pending",
      type: "rollback",
      connection_id: "11111111-1111-1111-1111-111111111111",
      parent_job_id: "parent-4",
      config: {}
    };
    function mockRollback({ laterLoad }) {
      queryMock.mockImplementation((sql) => {
        if (sql.includes("SELECT * FROM jobs WHERE id = $1 AND team_id = $2")) {
          return Promise.resolve({
            rows: [
              {
                id: "parent-4",
                team_id: "team-1",
                connection_id: rollbackJob.connection_id,
                result: { ledger: { entries: {} } }
              }
            ]
          });
        }
        if (sql.includes("SELECT * FROM jobs WHERE id = $1")) {
          return Promise.resolve({ rows: [rollbackJob] });
        }
        if (sql.includes("later.type = 'load'")) {
          return Promise.resolve({ rows: laterLoad ? [{ id: "later-load" }] : [] });
        }
        if (sql.includes("SELECT * FROM qbo_connections")) {
          return Promise.resolve({
            rows: [
              {
                id: rollbackJob.connection_id,
                realm_id: "r1",
                base_url: "https://sandbox-quickbooks.api.intuit.com",
                access_token_enc: "enc-access",
                refresh_token_enc: "enc-refresh",
                token_iv: "enc-iv"
              }
            ]
          });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });
    }

    it("keeps master data when a later load into the same sandbox may use it", async () => {
      rollbackLoad.mockClear();
      mockRollback({ laterLoad: true });
      await processJob({ jobId: rollbackJob.id, kind: "qbo" });
      expect(rollbackLoad).toHaveBeenCalledTimes(1);
      expect(rollbackLoad.mock.calls[0][4]).toEqual({ keepMasterData: true });
      const [sql, params] = queryMock.mock.calls.find(([q]) =>
        String(q).includes("later.type = 'load'")
      );
      // Matched on the sandbox (realm), not the connection row or the team.
      expect(params).toEqual(["parent-4"]);
      expect(sql).toContain("later.created_at > parent.created_at");
      expect(sql).toContain("later_conn.realm_id = parent_conn.realm_id");
      expect(sql).not.toContain("team_id");
    });

    it("makes master data inactive when no later load used the sandbox", async () => {
      rollbackLoad.mockClear();
      mockRollback({ laterLoad: false });
      await processJob({ jobId: rollbackJob.id, kind: "qbo" });
      expect(rollbackLoad.mock.calls[0][4]).toEqual({ keepMasterData: false });
    });
  });

  it("counts master data the rollback made inactive as rolled back", async () => {
    const rollbackJob = {
      id: "job-rb3",
      team_id: "team-1",
      status: "pending",
      type: "rollback",
      connection_id: "11111111-1111-1111-1111-111111111111",
      parent_job_id: "parent-3",
      config: {}
    };
    rollbackLoad.mockResolvedValueOnce({
      totalDeleted: 2,
      totalInactivated: 3,
      deletedByEntity: { invoice: 2 },
      inactivatedByEntity: { customer: 3 },
      failures: []
    });
    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1 AND team_id = $2")) {
        return Promise.resolve({
          rows: [{ id: "parent-3", team_id: "team-1", result: { ledger: { entries: {} } } }]
        });
      }
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) {
        return Promise.resolve({ rows: [rollbackJob] });
      }
      if (sql.includes("SELECT * FROM qbo_connections")) {
        return Promise.resolve({
          rows: [
            {
              id: rollbackJob.connection_id,
              realm_id: "r1",
              base_url: "https://sandbox-quickbooks.api.intuit.com",
              access_token_enc: "enc-access",
              refresh_token_enc: "enc-refresh",
              token_iv: "enc-iv"
            }
          ]
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await processJob({ jobId: rollbackJob.id, kind: "qbo" });

    const completed = queryMock.mock.calls.find(([q]) =>
      String(q).includes("SET status = 'completed'")
    );
    expect(completed[1][1]).toBe(5);
  });

  it("times out a hung QBO load: aborts its signal, fails the job, and does not retry", async () => {
    const job = {
      id: "job-timeout",
      team_id: "team-1",
      status: "pending",
      type: "load",
      connection_id: "11111111-1111-1111-1111-111111111111",
      config: {}
    };
    let receivedSignal;
    let abandonLoad;
    loadPlanIntoQboMock.mockImplementation((_client, _plan, _config, _emit, signal) => {
      receivedSignal = signal;
      return new Promise((_resolve, reject) => (abandonLoad = reject)); // ignores the abort
    });
    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) return Promise.resolve({ rows: [job] });
      if (sql.includes("SELECT * FROM qbo_connections WHERE id = $1 AND team_id = $2")) {
        return Promise.resolve({
          rows: [
            {
              id: job.connection_id,
              realm_id: "realm-1",
              base_url: "https://sandbox-quickbooks.api.intuit.com",
              access_token_enc: "enc-access",
              refresh_token_enc: "enc-refresh",
              token_iv: "enc-iv",
              connected_at: new Date().toISOString()
            }
          ]
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    enforceWorkerExecutionLimitsMock.mockResolvedValue({ deployment: "cloud" });

    const startedAt = Date.now();
    await expect(
      processJob({ jobId: job.id, kind: "qbo" }, { timeoutMs: 50, timeoutGraceMs: 40 })
    ).resolves.toBeUndefined();

    // The load never stopped, so the worker waited out the grace period before failing it.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(85);
    expect(receivedSignal.aborted).toBe(true);
    const failed = queryMock.mock.calls.find(
      ([sql, params]) => String(sql).includes("error = $2") && params?.[3] === job.id
    );
    expect(failed[1][1]).toContain("timed out");

    // Let the abandoned load end so it leaves no work running into other tests.
    abandonLoad(new Error("stopped"));
    await abortAndDrainJobs(new JobShutdownError());
  });

  it("completes the rollback and clears the parent's orphans status in one transaction", async () => {
    const rollbackJob = {
      id: "job-rb4",
      team_id: "team-1",
      status: "pending",
      type: "rollback",
      connection_id: "11111111-1111-1111-1111-111111111111",
      parent_job_id: "parent-4",
      config: {}
    };
    rollbackLoad.mockResolvedValueOnce({ totalDeleted: 2, failures: [] });
    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1 AND team_id = $2")) {
        return Promise.resolve({
          rows: [{ id: "parent-4", team_id: "team-1", result: { ledger: { entries: {} } } }]
        });
      }
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) {
        return Promise.resolve({ rows: [rollbackJob] });
      }
      if (sql.includes("SELECT * FROM qbo_connections")) {
        return Promise.resolve({
          rows: [
            {
              id: rollbackJob.connection_id,
              realm_id: "r1",
              base_url: "https://sandbox-quickbooks.api.intuit.com",
              access_token_enc: "enc-access",
              refresh_token_enc: "enc-refresh",
              token_iv: "enc-iv"
            }
          ]
        });
      }
      // The parent's update fails (e.g. the connection drops between the two writes).
      if (sql.includes("status = 'failed' WHERE id = $1 AND status = 'failed_with_orphans'")) {
        return Promise.reject(new Error("connection lost"));
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await expect(processJob({ jobId: rollbackJob.id, kind: "qbo" })).rejects.toThrow(
      "connection lost"
    );

    const sql = queryMock.mock.calls.map(([q]) => String(q).trim());
    const begin = sql.indexOf("BEGIN");
    const completed = sql.findIndex((q) => q.includes("SET status = 'completed'"));
    const parent = sql.findIndex((q) => q.includes("AND status = 'failed_with_orphans'"));
    // Both writes run inside one transaction, which is rolled back (never committed), so the
    // rollback job is not left completed while its load still reports orphans.
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(begin).toBeLessThan(completed);
    expect(completed).toBeLessThan(parent);
    expect(sql.slice(parent + 1)).toContain("ROLLBACK");
    expect(sql.slice(begin)).not.toContain("COMMIT");
    // The rollback job then fails normally, so it can be retried.
    const failed = queryMock.mock.calls.find(
      ([q, params]) => String(q).includes("status = $1") && params?.[0] === "failed"
    );
    expect(failed[1][3]).toBe(rollbackJob.id);
    expect(failed[1][1]).toMatch(/connection lost/);
  });

  it("counts a completed rollback as a used job like every other completed job", async () => {
    const rollbackJob = {
      id: "job-rb2",
      team_id: "team-1",
      status: "pending",
      type: "rollback",
      connection_id: "11111111-1111-1111-1111-111111111111",
      parent_job_id: "parent-2",
      config: {}
    };
    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1 AND team_id = $2")) {
        return Promise.resolve({
          rows: [
            {
              id: "parent-2",
              team_id: "team-1",
              connection_id: rollbackJob.connection_id,
              result: { ledger: { transactions: [] } }
            }
          ]
        });
      }
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) {
        return Promise.resolve({ rows: [rollbackJob] });
      }
      if (sql.includes("SELECT * FROM qbo_connections")) {
        return Promise.resolve({
          rows: [
            {
              id: rollbackJob.connection_id,
              realm_id: "r1",
              base_url: "https://sandbox-quickbooks.api.intuit.com",
              access_token_enc: "enc-access",
              refresh_token_enc: "enc-refresh",
              token_iv: "enc-iv"
            }
          ]
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    enforceWorkerExecutionLimitsMock.mockResolvedValue({ deployment: "cloud" });

    await processJob({ jobId: rollbackJob.id, kind: "qbo" });

    // A completed rollback counts toward monthly usage because it ends as a completed job.
    expect(
      queryMock.mock.calls.some(([sql]) => String(sql).includes("SET status = 'completed'"))
    ).toBe(true);
    expect(
      queryMock.mock.calls.some(([sql]) => String(sql).includes("SET status = 'failed' WHERE id"))
    ).toBe(true);
  });

  it("checks the limits for rollback jobs too", async () => {
    const job = {
      id: "rb-1",
      team_id: "team-1",
      status: "pending",
      type: "rollback",
      parent_job_id: "p-1"
    };
    queryMock.mockImplementation((sql) => {
      if (sql.includes("SELECT * FROM jobs WHERE id = $1")) return Promise.resolve({ rows: [job] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    enforceWorkerExecutionLimitsMock.mockRejectedValue(new Error("Monthly job limit exceeded."));

    await processJob({ jobId: job.id, kind: "qbo" });

    expect(enforceWorkerExecutionLimitsMock).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "rb-1" })
    );
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("status = 'running'"))).toBe(
      false
    );
  });

  describe("cancellation and terminal-status guards", () => {
    const CONN_ID = "11111111-1111-1111-1111-111111111111";
    const connRow = {
      id: CONN_ID,
      realm_id: "realm-1",
      base_url: "https://sandbox-quickbooks.api.intuit.com",
      access_token_enc: "enc-access",
      refresh_token_enc: "enc-refresh",
      token_iv: "enc-iv",
      connected_at: new Date().toISOString()
    };

    function mockLoadJob(job, { currentStatus = () => "running", updateRowCount = () => 1 } = {}) {
      queryMock.mockImplementation((sql) => {
        if (sql.includes("SELECT * FROM jobs WHERE id = $1")) {
          return Promise.resolve({ rows: [job] });
        }
        if (sql.includes("SELECT status FROM jobs")) {
          return Promise.resolve({ rows: [{ status: currentStatus() }] });
        }
        if (sql.includes("SELECT * FROM qbo_connections")) {
          return Promise.resolve({ rows: [connRow] });
        }
        return Promise.resolve({ rows: [], rowCount: updateRowCount(sql) });
      });
      enforceWorkerExecutionLimitsMock.mockResolvedValue({ deployment: "cloud" });
    }

    function loadThatStopsOnAbort(ledger) {
      loadPlanIntoQboMock.mockImplementation(
        (_client, _plan, _config, _emit, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              const err = new Error("Operation cancelled: client disconnected.");
              err.ledger = ledger;
              reject(err);
            });
          })
      );
    }

    const statusUpdates = () =>
      queryMock.mock.calls.filter(([sql]) => /UPDATE jobs SET status/.test(String(sql)));

    it("stops a running load once the job is cancelling and marks it cancelled", async () => {
      const job = {
        id: "job-c1",
        team_id: "team-1",
        status: "pending",
        type: "load",
        connection_id: CONN_ID,
        config: {}
      };
      let status = "running";
      mockLoadJob(job, { currentStatus: () => status });
      loadThatStopsOnAbort({ totalTracked: 0 });
      setTimeout(() => {
        status = "cancelling";
      }, 20);

      await expect(
        processJob({ jobId: job.id, kind: "qbo" }, { cancelPollMs: 5 })
      ).resolves.toBeUndefined();

      const last = statusUpdates().at(-1);
      expect(last[0]).toContain("status = 'cancelled'");
      expect(last[0]).toContain("status IN ('pending', 'running', 'cancelling')");
      expect(
        queryMock.mock.calls.some(([sql]) => String(sql).includes("SET status = 'completed'"))
      ).toBe(false);
      // The lock is released after the work stopped.
      expect(acquireLockMock).toHaveBeenCalledTimes(1);
      expect(releaseLockMock).toHaveBeenCalledTimes(1);
    });

    it("keeps the ledger of a cancelled load that created records so it can be rolled back", async () => {
      const job = {
        id: "job-c2",
        team_id: "team-1",
        status: "pending",
        type: "load",
        connection_id: CONN_ID,
        config: {}
      };
      let status = "running";
      mockLoadJob(job, { currentStatus: () => status });
      const ledger = { totalTracked: 4, transactions: [] };
      loadThatStopsOnAbort(ledger);
      setTimeout(() => {
        status = "cancelling";
      }, 20);

      await processJob({ jobId: job.id, kind: "qbo" }, { cancelPollMs: 5 });

      const last = statusUpdates().at(-1);
      expect(last[0]).toContain("status = 'failed_with_orphans'");
      expect(last[1][0]).toMatch(/^Cancelled after 4 record/);
      expect(JSON.parse(last[1][1])).toEqual({ ledger });
    });

    it("on timeout lets the load stop, keep its ledger (rollback-eligible) and release the lock before failing", async () => {
      const job = {
        id: "job-t2",
        team_id: "team-1",
        status: "pending",
        type: "load",
        connection_id: CONN_ID,
        config: {}
      };
      mockLoadJob(job);
      const ledger = { totalTracked: 30, transactions: [] };
      loadPlanIntoQboMock.mockImplementation(
        (_client, _plan, _config, _emit, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              // The current batch drains before the load gives up.
              setTimeout(() => {
                orderLog.push("load-rejected");
                const err = new Error("Operation cancelled: client disconnected.");
                err.ledger = ledger;
                reject(err);
              }, 30);
            });
          })
      );
      const baseQuery = queryMock.getMockImplementation();
      queryMock.mockImplementation((sql, params) => {
        const status = String(sql).match(/UPDATE jobs SET status = (?:'(\w+)'|\$1)/);
        if (status) orderLog.push(`status:${status[1] || params?.[0]}`);
        return baseQuery(sql, params);
      });

      await expect(
        processJob({ jobId: job.id, kind: "qbo" }, { timeoutMs: 20, timeoutGraceMs: 1000 })
      ).resolves.toBeUndefined();

      // The first terminal write is the load's own (with the ledger), after the load stopped;
      // the worker's plain 'failed' write comes later and is a no-op against the guard.
      const terminal = orderLog.filter(
        (entry) => entry.startsWith("status:") && entry !== "status:running"
      );
      expect(orderLog.indexOf("load-rejected")).toBeLessThan(
        orderLog.indexOf("status:failed_with_orphans")
      );
      expect(terminal[0]).toBe("status:failed_with_orphans");
      const orphaned = statusUpdates().find(([sql]) => String(sql).includes("status = $1"));
      expect(orphaned[1][0]).toBe("failed_with_orphans");
      expect(orphaned[1][1]).toContain("timed out");
      expect(JSON.parse(orphaned[1][2])).toEqual({ ledger });
    });

    it("does not start a job that was cancelled while queued", async () => {
      const job = {
        id: "job-c3",
        team_id: "team-1",
        status: "pending",
        type: "load",
        connection_id: CONN_ID,
        config: {}
      };
      mockLoadJob(job, {
        updateRowCount: (sql) => (sql.includes("status = 'running'") ? 0 : 1)
      });

      await processJob({ jobId: job.id, kind: "qbo" });

      expect(loadPlanIntoQboMock).not.toHaveBeenCalled();
      expect(acquireLockMock).not.toHaveBeenCalled();
    });

    it("does not flip a cancelled job to completed or count usage for it", async () => {
      const job = {
        id: "job-c4",
        team_id: "team-1",
        status: "pending",
        type: "load",
        connection_id: CONN_ID,
        config: {}
      };
      mockLoadJob(job, {
        updateRowCount: (sql) => (sql.includes("SET status = 'completed'") ? 0 : 1)
      });
      loadPlanIntoQboMock.mockResolvedValue({ counts: {}, failures: [], ledger: {} });
      writeJobArtifactMock.mockResolvedValue({ filename: "x.json", format: "json" });

      await processJob({ jobId: job.id, kind: "qbo" });

      const completed = queryMock.mock.calls.find(([sql]) =>
        String(sql).includes("SET status = 'completed'")
      );
      // Only a running job completes; a cancel that arrived meanwhile wins.
      expect(completed[0]).toContain("status = 'running'");
      expect(completed[0]).not.toContain("cancelling");
      expect(statusUpdates().at(-1)[0]).toContain("status = 'cancelled'");
    });

    it("keeps the ledger of a load that finished while it was being cancelled (rollback-eligible)", async () => {
      const job = {
        id: "job-c4b",
        team_id: "team-1",
        status: "pending",
        type: "load",
        connection_id: CONN_ID,
        config: {}
      };
      mockLoadJob(job, {
        currentStatus: () => "cancelling",
        updateRowCount: (sql) => (sql.includes("SET status = 'completed'") ? 0 : 1)
      });
      const ledger = { totalTracked: 3, entries: { invoice: [{ Id: "1" }] } };
      loadPlanIntoQboMock.mockResolvedValue({ counts: {}, failures: [], ledger });
      writeJobArtifactMock.mockResolvedValue({ filename: "x.json", format: "json" });

      await processJob({ jobId: job.id, kind: "qbo" });

      const last = statusUpdates().at(-1);
      expect(last[0]).toContain("status = 'failed_with_orphans'");
      expect(last[1][0]).toMatch(/^Cancelled after 3 record/);
      expect(JSON.parse(last[1][1])).toEqual({ ledger });
    });

    it("lets a load that stops after the timeout grace still record its ledger", async () => {
      const job = {
        id: "job-t3",
        team_id: "team-1",
        status: "pending",
        type: "load",
        connection_id: CONN_ID,
        config: {}
      };
      mockLoadJob(job);
      const ledger = { totalTracked: 12, transactions: [] };
      let settleLoad;
      const loadSettled = new Promise((resolve) => (settleLoad = resolve));
      loadPlanIntoQboMock.mockImplementation(
        (_client, _plan, _config, _emit, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              // The in-flight batches take longer than the grace period to drain.
              setTimeout(() => {
                orderLog.push("load-rejected");
                const err = new Error("Operation cancelled: client disconnected.");
                err.ledger = ledger;
                reject(err);
                setTimeout(settleLoad, 20);
              }, 80);
            });
          })
      );
      const baseQuery = queryMock.getMockImplementation();
      queryMock.mockImplementation((sql, params) => {
        const status = String(sql).match(/UPDATE jobs SET status = (?:'(\w+)'|\$1)/);
        if (status) orderLog.push(`status:${status[1] || params?.[0]}`);
        return baseQuery(sql, params);
      });

      await expect(
        processJob({ jobId: job.id, kind: "qbo" }, { timeoutMs: 20, timeoutGraceMs: 30 })
      ).resolves.toBeUndefined();
      orderLog.push("worker-gave-up");
      await loadSettled;

      // The worker failed the job first (flagged as timed out) ...
      expect(orderLog.indexOf("status:failed")).toBeLessThan(orderLog.indexOf("worker-gave-up"));
      const timedOut = statusUpdates().find(
        ([sql, params]) => String(sql).includes("status = $1") && params?.[0] === "failed"
      );
      expect(JSON.parse(timedOut[1][2])).toEqual({ timedOut: true });
      // ... and the load's late write may upgrade exactly that row with its ledger.
      expect(orderLog.indexOf("load-rejected")).toBeGreaterThan(orderLog.indexOf("worker-gave-up"));
      const orphaned = statusUpdates().find(
        ([sql, params]) =>
          String(sql).includes("status = $1") && params?.[0] === "failed_with_orphans"
      );
      expect(orphaned[0]).toContain("status = 'failed' AND result->>'timedOut' = 'true'");
      expect(orphaned[1][1]).toContain("timed out");
      expect(JSON.parse(orphaned[1][2])).toEqual({ ledger });
      // The worker's own timeout write never reopens a job (only the ledger write may).
      expect(timedOut[0]).not.toContain("timedOut");
    });

    it("keeps the ledger of a cancelled load whose batches drain past the timeout grace", async () => {
      // The user cancels (the signal's reason is JobCancelledError), the in-flight batches take
      // longer than the hard timeout + grace to drain, so the worker fails the row as timed out
      // first. The load's late cancel path then carries 3 tracked records: that ledger must
      // upgrade the timed-out row to failed_with_orphans (rollback-eligible), not be dropped.
      const job = {
        id: "job-t4",
        team_id: "team-1",
        status: "pending",
        type: "load",
        connection_id: CONN_ID,
        config: {}
      };
      let status = "pending";
      let result = null;
      const openStatuses = ["pending", "running", "cancelling"];
      mockLoadJob(job, {
        currentStatus: () => status,
        updateRowCount: (sql) => {
          if (!/UPDATE jobs SET status/.test(sql)) return 1;
          return 0; // status writes are simulated below
        }
      });
      // Simulate the DB's terminal-status guards on a status column.
      const baseQuery = queryMock.getMockImplementation();
      queryMock.mockImplementation((sql, params) => {
        const match = String(sql).match(/UPDATE jobs SET status = (?:'(\w+)'|\$1)/);
        if (!match) return baseQuery(sql, params);
        const next = match[1] || params[0];
        const timedOutFailed = status === "failed" && result?.timedOut === true;
        const allowed =
          openStatuses.includes(status) ||
          (timedOutFailed && String(sql).includes("result->>'timedOut' = 'true'"));
        if (!allowed) return Promise.resolve({ rows: [], rowCount: 0 });
        status = next;
        const resultParam = String(sql).includes("result = $2")
          ? params[1]
          : String(sql).includes("result = COALESCE($3, result)")
            ? params[2]
            : undefined;
        if (resultParam !== undefined && resultParam !== null) result = JSON.parse(resultParam);
        orderLog.push(`status:${next}`);
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      const ledger = { totalTracked: 3, transactions: [] };
      let settleLoad;
      const loadSettled = new Promise((resolve) => (settleLoad = resolve));
      loadPlanIntoQboMock.mockImplementation(
        (_client, _plan, _config, _emit, signal) =>
          new Promise((_resolve, reject) => {
            // Cancelled by the user once the load is running.
            setTimeout(() => (status = "cancelling"), 5);
            signal.addEventListener("abort", () => {
              setTimeout(() => {
                orderLog.push("load-rejected");
                const err = new Error("Operation cancelled: client disconnected.");
                err.ledger = ledger;
                reject(err);
                setTimeout(settleLoad, 20);
              }, 120);
            });
          })
      );

      await expect(
        processJob(
          { jobId: job.id, kind: "qbo" },
          { timeoutMs: 60, timeoutGraceMs: 20, cancelPollMs: 5 }
        )
      ).resolves.toBeUndefined();
      orderLog.push("worker-gave-up");
      await loadSettled;

      // Cancel came first, then the timeout failed the row while the batches were draining ...
      expect(orderLog.indexOf("status:failed")).toBeLessThan(orderLog.indexOf("worker-gave-up"));
      expect(orderLog.indexOf("load-rejected")).toBeGreaterThan(orderLog.indexOf("worker-gave-up"));
      // ... and the late cancel path still recorded the ledger on that row.
      expect(orderLog.at(-1)).toBe("status:failed_with_orphans");
      expect(status).toBe("failed_with_orphans");
      expect(result).toEqual({ ledger });
    });

    it("keeps a load that outlived its timeout grace registered until shutdown drains it", async () => {
      const job = {
        id: "job-s1",
        team_id: "team-1",
        status: "pending",
        type: "load",
        connection_id: CONN_ID,
        config: {}
      };
      mockLoadJob(job);
      const ledger = { totalTracked: 5, transactions: [] };
      let finishDraining;
      const batchesDrained = new Promise((resolve) => (finishDraining = resolve));
      // Stops only after its signal aborts, and its in-flight batches outlast the grace period.
      loadPlanIntoQboMock.mockImplementation(
        (_client, _plan, _config, _emit, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", async () => {
              await batchesDrained;
              const err = new Error("Operation cancelled: client disconnected.");
              err.ledger = ledger;
              reject(err);
            });
          })
      );
      const baseQuery = queryMock.getMockImplementation();
      queryMock.mockImplementation((sql, params) => {
        if (
          /UPDATE jobs SET status = \$1/.test(String(sql)) &&
          params?.[0] === "failed_with_orphans"
        ) {
          orderLog.push("ledger-written");
        }
        return baseQuery(sql, params);
      });

      await processJob({ jobId: job.id, kind: "qbo" }, { timeoutMs: 10, timeoutGraceMs: 10 });

      // processJob gave up at the grace period, but the load's work is still registered: the
      // drain waits for it.
      let drained = false;
      const draining = abortAndDrainJobs(new JobShutdownError()).then(() => {
        drained = true;
        orderLog.push("drained");
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(drained).toBe(false);

      finishDraining();
      await draining;
      expect(orderLog.indexOf("ledger-written")).toBeGreaterThan(-1);
      expect(orderLog.indexOf("ledger-written")).toBeLessThan(orderLog.indexOf("drained"));
      expect(releaseLockMock).toHaveBeenCalledTimes(1);
    });

    it("a shutdown during the timeout grace also waits for the worker's timeout write", async () => {
      const job = {
        id: "job-s0",
        team_id: "team-1",
        status: "pending",
        type: "load",
        connection_id: CONN_ID,
        config: {}
      };
      mockLoadJob(job);
      let finishDraining;
      const batchesDrained = new Promise((resolve) => (finishDraining = resolve));
      loadPlanIntoQboMock.mockImplementation(
        (_client, _plan, _config, _emit, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", async () => {
              await batchesDrained;
              reject(Object.assign(new Error("stopped"), { ledger: { totalTracked: 1 } }));
            });
          })
      );
      const baseQuery = queryMock.getMockImplementation();
      queryMock.mockImplementation((sql, params) => {
        if (params?.[2] === JSON.stringify({ timedOut: true })) orderLog.push("timeout-write");
        return baseQuery(sql, params);
      });

      // Times out at 10 ms and is still inside its (long) grace period when the server stops.
      const processing = processJob(
        { jobId: job.id, kind: "qbo" },
        { timeoutMs: 10, timeoutGraceMs: 10_000 }
      );
      await new Promise((r) => setTimeout(r, 30));
      const draining = abortAndDrainJobs(new JobShutdownError()).then(() =>
        orderLog.push("drained")
      );
      finishDraining();
      await draining;

      // The worker's own terminal write happened before the drain let the database close.
      expect(orderLog.indexOf("timeout-write")).toBeGreaterThan(-1);
      expect(orderLog.indexOf("timeout-write")).toBeLessThan(orderLog.indexOf("drained"));
      await processing;
    });

    it("a timeout that would fire during the shutdown drain never writes after it", async () => {
      const job = {
        id: "job-s4",
        team_id: "team-1",
        status: "pending",
        type: "load",
        connection_id: CONN_ID,
        config: {}
      };
      mockLoadJob(job);
      let started;
      const loadStarted = new Promise((resolve) => (started = resolve));
      // After the shutdown abort the in-flight batches take 60 ms, past the 30 ms timeout.
      loadPlanIntoQboMock.mockImplementation(
        (_client, _plan, _config, _emit, signal) =>
          new Promise((_resolve, reject) => {
            started();
            signal.addEventListener("abort", () =>
              setTimeout(() => reject(new Error("stopped")), 60)
            );
          })
      );

      const processing = processJob(
        { jobId: job.id, kind: "qbo" },
        { timeoutMs: 30, timeoutGraceMs: 1000 }
      );
      await loadStarted;
      await abortAndDrainJobs(new JobShutdownError());
      const writesAtDrain = queryMock.mock.calls.length;
      await processing.catch(() => {});
      await new Promise((r) => setTimeout(r, 50));

      // Nothing reached the database after the drain resolved, and no timeout was recorded.
      expect(queryMock.mock.calls.length).toBe(writesAtDrain);
      expect(
        queryMock.mock.calls.some(
          ([, params]) => params?.[2] === JSON.stringify({ timedOut: true })
        )
      ).toBe(false);
      expect(statusUpdates().at(-1)[1][1]).toBe("Interrupted by a server shutdown.");
    });

    it("leaves a dispatched job pending when shutdown aborts it before its claim", async () => {
      const job = {
        id: "job-s5",
        team_id: "team-1",
        status: "pending",
        type: "load",
        connection_id: CONN_ID,
        config: {}
      };
      mockLoadJob(job);
      let finishLimitCheck;
      enforceWorkerExecutionLimitsMock.mockImplementation(
        () => new Promise((resolve) => (finishLimitCheck = resolve))
      );

      const processing = processJob({ jobId: job.id, kind: "qbo" });
      await vi.waitFor(() => expect(finishLimitCheck).toBeTypeOf("function"));
      const draining = abortAndDrainJobs(new JobShutdownError());
      finishLimitCheck({ deployment: "cloud" });
      await draining;
      await processing;

      // Never claimed and never failed: it stays pending and runs after the restart.
      expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("status = 'running'"))).toBe(
        false
      );
      expect(statusUpdates()).toEqual([]);
      expect(loadPlanIntoQboMock).not.toHaveBeenCalled();
    });

    it("leaves a dispatched rollback pending when shutdown aborts it before its claim", async () => {
      const job = {
        id: "job-s6",
        team_id: "team-1",
        status: "pending",
        type: "rollback",
        connection_id: CONN_ID,
        parent_job_id: "p-1",
        config: {}
      };
      mockLoadJob(job);
      let finishLimitCheck;
      enforceWorkerExecutionLimitsMock.mockImplementation(
        () => new Promise((resolve) => (finishLimitCheck = resolve))
      );

      const processing = processJob({ jobId: job.id, kind: "qbo" });
      await vi.waitFor(() => expect(finishLimitCheck).toBeTypeOf("function"));
      const draining = abortAndDrainJobs(new JobShutdownError());
      finishLimitCheck({ deployment: "cloud" });
      await draining;
      await processing;

      expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("status = 'running'"))).toBe(
        false
      );
      expect(statusUpdates()).toEqual([]);
    });

    it("on shutdown stops a running load at its next batch and keeps its ledger", async () => {
      const job = {
        id: "job-s2",
        team_id: "team-1",
        status: "pending",
        type: "load",
        connection_id: CONN_ID,
        config: {}
      };
      mockLoadJob(job);
      const ledger = { totalTracked: 2, transactions: [] };
      let started;
      const loadStarted = new Promise((resolve) => (started = resolve));
      loadPlanIntoQboMock.mockImplementation(
        (_client, _plan, _config, _emit, signal) =>
          new Promise((_resolve, reject) => {
            started();
            signal.addEventListener("abort", () => {
              const err = new Error("Operation cancelled: client disconnected.");
              err.ledger = ledger;
              reject(err);
            });
          })
      );

      const running = processJob({ jobId: job.id, kind: "qbo" });
      await loadStarted;
      await abortAndDrainJobs(new JobShutdownError());
      await expect(running).resolves.toBeUndefined();

      const last = statusUpdates().at(-1);
      expect(last[1][0]).toBe("failed_with_orphans");
      expect(last[1][1]).toBe("Interrupted by a server shutdown.");
      expect(JSON.parse(last[1][2])).toEqual({ ledger });
    });

    it("an admin force-fail aborts the running load, which fails through its normal path", async () => {
      const job = {
        id: "job-ff1",
        team_id: "team-1",
        status: "pending",
        type: "load",
        connection_id: CONN_ID,
        config: {}
      };
      mockLoadJob(job);
      const ledger = { totalTracked: 3, transactions: [] };
      let started;
      const loadStarted = new Promise((resolve) => (started = resolve));
      loadPlanIntoQboMock.mockImplementation(
        (_client, _plan, _config, _emit, signal) =>
          new Promise((_resolve, reject) => {
            started();
            signal.addEventListener("abort", () => {
              const err = new Error("Operation cancelled: client disconnected.");
              err.ledger = ledger;
              reject(err);
            });
          })
      );

      expect(abortRunningJob("not-running-here", new JobForceFailedError())).toBe(false);
      const running = processJob({ jobId: job.id, kind: "qbo" });
      await loadStarted;
      expect(abortRunningJob(job.id, new JobForceFailedError())).toBe(true);
      await expect(running).resolves.toBeUndefined();

      // The worker's own failure write keeps the ledger, and the lock is released after it.
      const last = statusUpdates().at(-1);
      expect(last[1][0]).toBe("failed_with_orphans");
      expect(last[1][1]).toBe("Force-failed by admin");
      expect(JSON.parse(last[1][2])).toEqual({ ledger });
      expect(releaseLockMock).toHaveBeenCalledTimes(1);
      expect(abortRunningJob(job.id, new JobForceFailedError())).toBe(false);
    });

    it("binds a purge's QBO client to the job's signal, and a cancelled purge ends cancelled", async () => {
      const { QboClient } = await import("@easytestdata/qbo-client");
      const job = {
        id: "job-p1",
        team_id: "team-1",
        status: "pending",
        type: "purge",
        connection_id: CONN_ID,
        config: {}
      };
      let status = "running";
      mockLoadJob(job, { currentStatus: () => status });
      let purgeSignal;
      purgeTransactions.mockImplementation(
        (_client, _options, _emit, signal) =>
          new Promise((_resolve, reject) => {
            purgeSignal = signal;
            status = "cancelling";
            signal.addEventListener("abort", () => reject(new Error("Operation cancelled.")));
          })
      );

      await processJob({ jobId: job.id, kind: "qbo" }, { cancelPollMs: 5 });

      // The client refuses every request once this signal aborts (QboClient's `signal`).
      expect(QboClient.mock.calls.at(-1)[0].signal).toBe(purgeSignal);
      expect(purgeSignal.aborted).toBe(true);
      const last = statusUpdates().at(-1);
      expect(last[0]).toContain("status = 'cancelled'");
    });

    it("on shutdown fails a running purge with the shutdown message", async () => {
      const job = {
        id: "job-s3",
        team_id: "team-1",
        status: "pending",
        type: "purge",
        connection_id: CONN_ID,
        config: {}
      };
      mockLoadJob(job);
      let started;
      const purgeStarted = new Promise((resolve) => (started = resolve));
      purgeTransactions.mockImplementation(
        (_client, _options, _emit, signal) =>
          new Promise((_resolve, reject) => {
            started();
            signal.addEventListener("abort", () => reject(new Error("Operation cancelled.")));
          })
      );

      const running = processJob({ jobId: job.id, kind: "qbo" });
      await purgeStarted;
      await abortAndDrainJobs(new JobShutdownError());
      await expect(running).rejects.toThrow("Operation cancelled.");

      const last = statusUpdates().at(-1);
      expect(last[1][0]).toBe("failed");
      expect(last[1][1]).toBe("Interrupted by a server shutdown.");
    });

    it("persists the final progress step before the job's terminal status", async () => {
      const job = {
        id: "job-p1",
        team_id: "team-1",
        status: "pending",
        type: "load",
        connection_id: CONN_ID,
        config: {}
      };
      mockLoadJob(job);
      // Progress is throttled to one write a second: steps 2..11 arrive inside that window.
      loadPlanIntoQboMock.mockImplementation(async (_client, _plan, _config, emit) => {
        for (let step = 1; step <= 11; step++) {
          emit({ step, totalSteps: 11, message: `Phase ${step}` });
        }
        return { counts: {}, failures: [], ledger: {} };
      });
      writeJobArtifactMock.mockResolvedValue({ filename: "x.json", format: "json" });

      await processJob({ jobId: job.id, kind: "qbo" });

      const calls = queryMock.mock.calls.map(([sql]) => String(sql));
      const completedAt = calls.findIndex((sql) => sql.includes("SET status = 'completed'"));
      const progressWrites = queryMock.mock.calls
        .map(([sql, params], index) => ({ sql: String(sql), params, index }))
        .filter(({ sql }) => sql.includes("SET progress"));
      const lastProgress = progressWrites.at(-1);
      expect(JSON.parse(lastProgress.params[0]).step).toBe(11);
      expect(lastProgress.index).toBeLessThan(completedAt);
      // Still throttled: the first step and the final one, not all eleven.
      expect(progressWrites).toHaveLength(2);
    });

    it("leaves alone a job that is no longer pending (the claim is the only arbiter)", async () => {
      const job = {
        id: "job-c6",
        team_id: "team-1",
        status: "running",
        type: "load",
        connection_id: CONN_ID,
        config: {}
      };
      mockLoadJob(job);

      await processJob({ jobId: job.id, kind: "qbo" });

      expect(loadPlanIntoQboMock).not.toHaveBeenCalled();
      expect(statusUpdates()).toEqual([]);
    });
  });
});

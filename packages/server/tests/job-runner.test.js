import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ jobs: [], selectGate: null }));
vi.mock("../src/db/pool.js", () => ({
  query: vi.fn(async (sql, params) => {
    if (sql.includes("status IN ('running', 'cancelling')")) {
      const hit = db.jobs.filter((j) => ["running", "cancelling"].includes(j.status));
      for (const j of hit) j.status = j.status === "cancelling" ? "cancelled" : "failed";
      return { rowCount: hit.length, rows: [] };
    }
    if (sql.includes("status = 'pending' AND type = ANY($1)")) {
      if (db.selectGate) await db.selectGate;
      const [types, exclude, limit] = params;
      return {
        rows: db.jobs
          .filter(
            (j) => j.status === "pending" && types.includes(j.type) && !exclude.includes(j.id)
          )
          .slice(0, limit)
          .map(({ id }) => ({ id }))
      };
    }
    return { rows: [], rowCount: 0 };
  })
}));
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
const drain = vi.hoisted(() => ({ calls: [] }));
vi.mock("../src/workers/index.js", () => ({
  processJob: vi.fn(),
  JobShutdownError: class JobShutdownError extends Error {},
  abortAndDrainJobs: vi.fn(async (reason) => drain.calls.push(reason))
}));
vi.mock("../src/workers/token-refresh.js", () => ({
  refreshExpiringTokens: vi.fn(async () => {})
}));
vi.mock("../src/services/job-artifacts.js", () => ({
  cleanupExpiredArtifacts: vi.fn(async () => {})
}));

const { notifyJobQueued, recoverInterruptedJobs, startJobRunner } =
  await import("../src/workers/runner.js");
const { cleanupExpiredArtifacts } = await import("../src/services/job-artifacts.js");
const { logger } = await import("../src/logger.js");
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("job runner", () => {
  beforeEach(() => {
    db.jobs = [];
    db.selectGate = null;
  });

  it("runs at most qboConcurrency QBO jobs and starts waiting ones in order as slots free", async () => {
    db.jobs = ["a", "b", "c"].map((id) => ({ id, type: "load", status: "pending" }));
    const release = {};
    const started = [];
    const process = vi.fn(({ jobId }) => {
      started.push(jobId);
      const job = db.jobs.find((j) => j.id === jobId);
      job.status = "running";
      return new Promise(
        (resolve) => (release[jobId] = () => ((job.status = "completed"), resolve()))
      );
    });
    const runner = await startJobRunner({
      qboConcurrency: 2,
      localConcurrency: 1,
      pollMs: 10,
      process
    });
    await tick();
    expect(started).toEqual(["a", "b"]);
    release.a();
    await tick();
    expect(started).toEqual(["a", "b", "c"]);
    release.b();
    release.c();
    await runner.stop();
  });

  it("recovers interrupted jobs before dispatching anything", async () => {
    db.jobs = [
      { id: "r", type: "load", status: "running" },
      { id: "p", type: "load", status: "pending" }
    ];
    const process = vi.fn(async ({ jobId }) => {
      db.jobs.find((j) => j.id === jobId).status = "completed"; // claims and finishes, like processJob
    });
    notifyJobQueued(); // before start: no-op
    const runner = await startJobRunner({
      qboConcurrency: 2,
      localConcurrency: 1,
      pollMs: 10,
      process
    });
    await tick();
    expect(db.jobs.find((j) => j.id === "r").status).toBe("failed");
    expect(process.mock.calls.map(([arg]) => arg.jobId)).toEqual(["p"]);
    await runner.stop();
  });

  it("dispatches nothing after stop(), even when a poll was mid-query", async () => {
    db.jobs = [{ id: "a", type: "generate", status: "pending" }];
    let openGate;
    db.selectGate = new Promise((r) => (openGate = r));
    const process = vi.fn(async () => {});
    const runner = await startJobRunner({
      qboConcurrency: 1,
      localConcurrency: 1,
      pollMs: 5,
      process
    });
    await tick();
    const stopping = runner.stop();
    openGate();
    await stopping;
    await tick();
    expect(process).not.toHaveBeenCalled();
  });

  it("aborts and drains still-running jobs on stop() after drainMs", async () => {
    db.jobs = [{ id: "slow", type: "load", status: "pending" }];
    const runner = await startJobRunner({
      qboConcurrency: 1,
      localConcurrency: 1,
      pollMs: 60_000,
      drainMs: 20,
      process: () => new Promise(() => {}) // never finishes on its own
    });
    await tick();
    drain.calls.length = 0;
    await runner.stop();
    expect(drain.calls).toHaveLength(1);
  });

  it("does not dispatch a job again while it is still in flight, even if it stays pending", async () => {
    db.jobs = [{ id: "slow", type: "load", status: "pending" }];
    let finish;
    // Never claims the row (it stays pending), and runs across many polls.
    const process = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    const runner = await startJobRunner({
      qboConcurrency: 2,
      localConcurrency: 1,
      pollMs: 5,
      process
    });
    await tick();
    await tick();
    expect(process).toHaveBeenCalledTimes(1);
    finish();
    db.jobs[0].status = "completed";
    await runner.stop();
  });

  it("notifyJobQueued() wakes a runner whose next poll is far away", async () => {
    const process = vi.fn(async ({ jobId }) => {
      db.jobs.find((j) => j.id === jobId).status = "completed";
    });
    const runner = await startJobRunner({
      qboConcurrency: 1,
      localConcurrency: 1,
      pollMs: 60_000,
      process
    });
    await tick(); // the first poll found nothing; the next one is a minute away
    db.jobs = [{ id: "new", type: "generate", status: "pending" }];
    await tick();
    expect(process).not.toHaveBeenCalled();
    notifyJobQueued();
    await tick();
    expect(process).toHaveBeenCalledTimes(1);
    await runner.stop();
  });

  it("closes out jobs left running or cancelling", async () => {
    db.jobs = [
      { id: "r", type: "load", status: "running" },
      { id: "c", type: "load", status: "cancelling" },
      { id: "p", type: "load", status: "pending" }
    ];
    expect(await recoverInterruptedJobs()).toBe(2);
    expect(db.jobs.map((j) => j.status)).toEqual(["failed", "cancelled", "pending"]);
  });

  it("runs one artifact cleanup at startup, after recovery, without holding up dispatch", async () => {
    db.jobs = [
      { id: "stale", type: "load", status: "running" },
      { id: "g", type: "generate", status: "pending" }
    ];
    cleanupExpiredArtifacts.mockClear();
    let finishCleanup;
    let statusesAtCleanup;
    cleanupExpiredArtifacts.mockImplementationOnce(() => {
      statusesAtCleanup = db.jobs.map((j) => j.status);
      return new Promise((r) => (finishCleanup = r));
    });
    const process = vi.fn(async () => {});
    const runner = await startJobRunner({
      process,
      pollMs: 60_000,
      maintenanceMs: { tokenRefresh: 60_000, artifactCleanup: 60_000 }
    });
    await tick();
    expect(cleanupExpiredArtifacts).toHaveBeenCalledTimes(1);
    expect(cleanupExpiredArtifacts).toHaveBeenCalledWith({ ttlDays: expect.any(Number) });
    expect(statusesAtCleanup[0]).toBe("failed");
    // The cleanup is still running; the queued job started anyway.
    expect(process).toHaveBeenCalledWith({ jobId: "g", kind: "local" });
    let stopped = false;
    const stopping = runner.stop().then(() => (stopped = true));
    await tick();
    expect(stopped).toBe(false);
    finishCleanup();
    await stopping;
  });

  it("runs one token keepalive at startup, after recovery, without holding up dispatch", async () => {
    const { refreshExpiringTokens } = await import("../src/workers/token-refresh.js");
    db.jobs = [
      { id: "stale2", type: "load", status: "running" },
      { id: "g3", type: "generate", status: "pending" }
    ];
    refreshExpiringTokens.mockClear();
    let finishRefresh;
    let statusesAtRefresh;
    refreshExpiringTokens.mockImplementationOnce(() => {
      statusesAtRefresh = db.jobs.map((j) => j.status);
      return new Promise((r) => (finishRefresh = r));
    });
    const process = vi.fn(async () => {});
    const runner = await startJobRunner({
      process,
      pollMs: 60_000,
      // The daily interval never fires during the test: this is the startup run.
      maintenanceMs: { tokenRefresh: 86_400_000, artifactCleanup: 60_000 }
    });
    await tick();
    expect(refreshExpiringTokens).toHaveBeenCalledTimes(1);
    expect(statusesAtRefresh[0]).toBe("failed");
    expect(process).toHaveBeenCalledWith({ jobId: "g3", kind: "local" });
    let stopped = false;
    const stopping = runner.stop().then(() => (stopped = true));
    await tick();
    expect(stopped).toBe(false); // stop() waits for the keepalive (it persists rotated tokens)
    finishRefresh();
    await stopping;
  });

  it("stops waiting for a startup keepalive after drainMs, having told it to stop", async () => {
    const { refreshExpiringTokens } = await import("../src/workers/token-refresh.js");
    refreshExpiringTokens.mockClear();
    logger.warn.mockClear();
    // A keepalive over many sandboxes that never finishes on its own (e.g. one slow Intuit call).
    let signal;
    refreshExpiringTokens.mockImplementationOnce((opts) => {
      signal = opts?.signal;
      return new Promise(() => {});
    });
    const runner = await startJobRunner({
      process: vi.fn(async () => {}),
      pollMs: 60_000,
      drainMs: 30,
      maintenanceMs: { tokenRefresh: 86_400_000, artifactCleanup: 60_000 }
    });
    await tick();
    expect(refreshExpiringTokens).toHaveBeenCalledTimes(1);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    const outcome = await Promise.race([
      runner.stop().then(() => "stopped"),
      new Promise((r) => setTimeout(() => r("still waiting"), 1000))
    ]);
    expect(outcome).toBe("stopped");
    // The keepalive was told to stop first (no further refresh starts), and the shutdown says
    // it was still running.
    expect(signal.aborted).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      { drainMs: 30 },
      expect.stringMatching(/Maintenance still running at shutdown/)
    );
  });

  it("logs a failed startup cleanup and keeps running", async () => {
    db.jobs = [{ id: "g2", type: "generate", status: "pending" }];
    cleanupExpiredArtifacts.mockRejectedValueOnce(new Error("disk gone"));
    logger.error.mockClear();
    const process = vi.fn(async () => {});
    const runner = await startJobRunner({
      process,
      pollMs: 60_000,
      maintenanceMs: { tokenRefresh: 60_000, artifactCleanup: 60_000 }
    });
    await tick();
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: "disk gone" }) },
      "Artifact cleanup failed"
    );
    expect(process).toHaveBeenCalledWith({ jobId: "g2", kind: "local" });
    await runner.stop();
  });

  it("runs artifact cleanup with a ttl and waits for it on stop()", async () => {
    let finishCleanup;
    cleanupExpiredArtifacts.mockImplementationOnce(() => new Promise((r) => (finishCleanup = r)));
    const runner = await startJobRunner({
      process: vi.fn(async () => {}),
      pollMs: 60_000,
      maintenanceMs: { tokenRefresh: 60_000, artifactCleanup: 15 }
    });
    await tick();
    expect(cleanupExpiredArtifacts).toHaveBeenCalledWith({ ttlDays: expect.any(Number) });
    let stopped = false;
    const stopping = runner.stop().then(() => (stopped = true));
    await tick();
    expect(stopped).toBe(false);
    finishCleanup();
    await stopping;
  });
});

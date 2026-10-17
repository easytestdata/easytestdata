import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Extension jobs end to end on an embedded PGlite database: descriptor validation, enqueueing
// through the connection guard and the one-active-QBO-job rule, the runner's dispatch, outcome
// rules (completed / AppError / other error / cancel / missing handler), the handler's own
// timeout, and the sandbox target handed to needsSandbox handlers.
const dir = mkdtempSync(join(tmpdir(), "eztd-extension-jobs-"));
vi.stubEnv("DEPLOYMENT", "local");
vi.stubEnv("EASYTESTDATA_DATA_DIR", dir);
vi.stubEnv("TOKEN_ENCRYPTION_KEY", "ab".repeat(32));
vi.stubEnv("QBO_CLIENT_ID", "client-id");
vi.stubEnv("QBO_CLIENT_SECRET", "client-secret");

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));
const db = await import("../src/db/pool.js");
const { runMigrations } = await import("../src/db/migrate.js");
const { config } = await import("../src/config.js");
const { AppError } = await import("../src/errors.js");
const { encryptTokenPair } = await import("../src/crypto/tokens.js");
const { validateExtensions } = await import("../src/extensions.js");
const { registerExtensionJobs, extensionJobTimeoutMs } =
  await import("../src/workers/extension-jobs.js");
const { processJob, abortRunningJob, abortAndDrainJobs, JobForceFailedError, JobShutdownError } =
  await import("../src/workers/index.js");
const { getMonthlyUsage } = await import("../src/services/limits.js");
const api = await import("../src/services/extension-jobs-api.js");
const { QboClient } = await import("@easytestdata/qbo-client");

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function register(jobs) {
  const extension = { name: "demo", jobs };
  validateExtensions([extension]);
  registerExtensionJobs([extension]);
}

async function createTeam(name, { connected = true } = {}) {
  const team = (await db.query("INSERT INTO teams (name) VALUES ($1) RETURNING id", [name]))
    .rows[0];
  const tokens = encryptTokenPair("access", "refresh");
  const connection = (
    await db.query(
      `INSERT INTO qbo_connections (team_id, realm_id, access_token_enc, refresh_token_enc, token_iv,
         disconnected_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        team.id,
        `realm-${name}`,
        tokens.access_token_enc,
        tokens.refresh_token_enc,
        tokens.token_iv,
        connected ? null : new Date()
      ]
    )
  ).rows[0];
  return { teamId: team.id, connectionId: connection.id };
}

const job = async (id) => (await db.query("SELECT * FROM jobs WHERE id = $1", [id])).rows[0];
const run = (id, options = {}) =>
  processJob({ jobId: id, kind: "qbo" }, { cancelPollMs: 10, ...options });

describe("extension descriptors: jobs", () => {
  const ok = { run: () => {}, needsSandbox: false };
  it.each([
    [{ jobs: [] }, /jobs must be a plain object/],
    [{ jobs: { Bad: ok } }, /job kind Bad must match/],
    [{ jobs: { copy: { needsSandbox: false } } }, /must have a run function/],
    [{ jobs: { copy: { run: () => {} } } }, /needsSandbox must be a boolean/],
    [{ jobs: { copy: { ...ok, timeoutMinutes: 0 } } }, /timeoutMinutes must be an integer/],
    [{ jobs: { copy: { ...ok, timeoutMinutes: 241 } } }, /timeoutMinutes must be an integer/]
  ])("refuses %o", (fields, message) => {
    expect(() => validateExtensions([{ name: "demo", ...fields }])).toThrow(message);
  });

  it("accepts a valid jobs map", () => {
    expect(() =>
      validateExtensions([{ name: "demo", jobs: { copy: { ...ok, timeoutMinutes: 180 } } }])
    ).not.toThrow();
  });
});

describe("extension jobs on PGlite", () => {
  beforeAll(async () => runMigrations({ closePool: false }), 60_000);
  afterAll(async () => {
    await db.closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("queues a row with { extension, kind, payload } and keeps one active QBO job per team", async () => {
    const team = await createTeam("enqueue");
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      extension: "demo",
      kind: "prepare",
      payload: { readId: "r1" }
    });
    const row = await job(id);
    expect(row).toMatchObject({ type: "extension", status: "pending", connection_id: null });
    expect(row.config).toEqual({ extension: "demo", kind: "prepare", payload: { readId: "r1" } });

    const second = await api
      .enqueueExtensionJob({ teamId: team.teamId, extension: "demo", kind: "prepare" })
      .catch((err) => err);
    expect(second).toBeInstanceOf(AppError);
    expect(second.statusCode).toBe(409);
    const load = await db
      .query("INSERT INTO jobs (team_id, connection_id, type) VALUES ($1, $2, 'load')", [
        team.teamId,
        team.connectionId
      ])
      .catch((err) => err);
    expect(load.message).toMatch(/jobs_one_active_qbo_job_per_team/);
  });

  it("refuses a disconnected sandbox and runs check under the locks", async () => {
    const gone = await createTeam("gone", { connected: false });
    await expect(
      api.enqueueExtensionJob({
        teamId: gone.teamId,
        connectionId: gone.connectionId,
        extension: "demo",
        kind: "copy"
      })
    ).rejects.toMatchObject({ statusCode: 409 });

    const team = await createTeam("check");
    const check = vi.fn(async () => {
      throw new AppError(409, "NOPE", "Refused by check.");
    });
    await expect(
      api.enqueueExtensionJob({
        teamId: team.teamId,
        connectionId: team.connectionId,
        extension: "demo",
        kind: "copy",
        check
      })
    ).rejects.toThrow("Refused by check.");
    expect(check).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: team.connectionId })
    );
  });

  it("refuses invalid names before touching the database", async () => {
    await expect(
      api.enqueueExtensionJob({ teamId: "x", extension: "Demo", kind: "copy" })
    ).rejects.toThrow(/valid extension name/);
  });

  it("runs the handler with ctx and completes with its result and entity count", async () => {
    const seen = [];
    register({
      prepare: {
        needsSandbox: false,
        run: async (ctx) => {
          seen.push(ctx);
          ctx.progress(1, 2, "Reading invoices");
          return { result: { counts: { Invoice: 3 } }, entityCount: 3 };
        }
      }
    });
    const team = await createTeam("happy");
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      createdBy: null,
      extension: "demo",
      kind: "prepare",
      payload: { readId: "r2" }
    });
    await run(id);
    const row = await job(id);
    expect(row).toMatchObject({ status: "completed", entity_count: 3 });
    expect(row.result).toEqual({ counts: { Invoice: 3 } });
    expect(row.progress).toMatchObject({ step: 1, totalSteps: 2, message: "Reading invoices" });
    expect(seen[0]).toMatchObject({ jobId: id, teamId: team.teamId, config: { readId: "r2" } });
    expect(seen[0].target).toBeNull();
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it("fails with an AppError's message and keeps the error's result", async () => {
    register({
      copy: {
        needsSandbox: false,
        run: async () => {
          throw Object.assign(new AppError(409, "X", "The read has expired."), {
            result: { issues: 1 }
          });
        }
      }
    });
    const team = await createTeam("apperror");
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      extension: "demo",
      kind: "copy"
    });
    await run(id);
    expect(await job(id)).toMatchObject({
      status: "failed",
      error: "The read has expired.",
      result: { issues: 1 }
    });
  });

  it("replaces any other error's message (it may hold internals) and logs it", async () => {
    register({
      copy: {
        needsSandbox: false,
        run: async () => {
          throw new Error("SELECT secret FROM somewhere failed");
        }
      }
    });
    const team = await createTeam("generic");
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      extension: "demo",
      kind: "copy"
    });
    await run(id);
    expect((await job(id)).error).toBe("The job failed. See the server log for details.");
  });

  it("ends cancelled with the partial result when cancelled while running", async () => {
    register({
      copy: {
        needsSandbox: false,
        run: (ctx) =>
          new Promise((_resolve, reject) => {
            ctx.signal.addEventListener("abort", () =>
              reject(Object.assign(new Error("stopped"), { result: { written: 30 } }))
            );
          })
      }
    });
    const team = await createTeam("cancel");
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      extension: "demo",
      kind: "copy"
    });
    const running = run(id);
    await tick(50);
    expect((await api.cancelExtensionJob(team.teamId, id)).status).toBe("cancelling");
    await running;
    expect(await job(id)).toMatchObject({ status: "cancelled", result: { written: 30 } });
  });

  it("never completes a job force-failed while its handler was finishing", async () => {
    register({
      copy: {
        needsSandbox: false,
        run: (ctx) =>
          new Promise((resolve) =>
            ctx.signal.addEventListener("abort", () => resolve({ result: { partial: true } }))
          )
      }
    });
    const team = await createTeam("forcefail");
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      extension: "demo",
      kind: "copy"
    });
    const running = run(id);
    await tick(50);
    expect(abortRunningJob(id, new JobForceFailedError())).toBe(true);
    await running;
    const row = await job(id);
    expect(row.status).toBe("failed");
    expect(row.result).toEqual({ partial: true });
  });

  it("ends a cancel that drained past the timeout cancelled, without the timeout's error", async () => {
    register({
      copy: {
        needsSandbox: false,
        run: async () => {
          await tick(400);
          throw new Error("stopped late");
        }
      }
    });
    const team = await createTeam("latecancel");
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      extension: "demo",
      kind: "copy"
    });
    const running = run(id, { timeoutMs: 100, timeoutGraceMs: 20 });
    await tick(30);
    await api.cancelExtensionJob(team.teamId, id);
    await running;
    expect((await job(id)).status).toBe("failed"); // failed at the timeout while still draining
    await tick(450);
    const row = await job(id);
    expect(row).toMatchObject({ status: "cancelled", error: null, result: null });
  });

  it("leaves a job pending, and the drain waits for it, when shutdown lands while its timeout is read", async () => {
    const runFn = vi.fn();
    register({ copy: { needsSandbox: false, run: runFn } });
    const team = await createTeam("shutdown");
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      extension: "demo",
      kind: "copy"
    });
    let finished = false;
    const running = run(id).then(() => (finished = true));
    await abortAndDrainJobs(new JobShutdownError());
    expect(finished).toBe(true);
    await running;
    expect((await job(id)).status).toBe("pending");
    expect(runFn).not.toHaveBeenCalled();
  });

  it("never starts the handler when stopped while waiting for the connection lock", async () => {
    const runFn = vi.fn();
    register({ copy: { needsSandbox: true, run: runFn } });
    const team = await createTeam("lockwait");
    const { withConnectionLock } = await import("../src/services/connection-lock.js");
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      connectionId: team.connectionId,
      extension: "demo",
      kind: "copy"
    });
    let release;
    const held = withConnectionLock(team.connectionId, () => new Promise((r) => (release = r)));
    const running = run(id, { lockWaitMs: 2000 });
    await tick(60);
    await api.cancelExtensionJob(team.teamId, id);
    await tick(60);
    release();
    await held;
    await running;
    expect(runFn).not.toHaveBeenCalled();
    expect((await job(id)).status).toBe("cancelled");
  });

  it("puts a job shut down before its handler started back to pending", async () => {
    const runFn = vi.fn();
    register({ copy: { needsSandbox: true, run: runFn } });
    const team = await createTeam("lockshutdown");
    const { withConnectionLock } = await import("../src/services/connection-lock.js");
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      connectionId: team.connectionId,
      extension: "demo",
      kind: "copy"
    });
    let release;
    const held = withConnectionLock(team.connectionId, () => new Promise((r) => (release = r)));
    const running = run(id, { lockWaitMs: 2000 });
    await tick(60);
    const drained = abortAndDrainJobs(new JobShutdownError());
    await tick(20);
    release();
    await held;
    await Promise.all([running, drained]);
    expect(runFn).not.toHaveBeenCalled();
    expect((await job(id)).status).toBe("pending");
  });

  it("still ends a job whose result can't be saved", async () => {
    const team = await createTeam("unserializable");
    const failing = await api.enqueueExtensionJob({
      teamId: team.teamId,
      extension: "demo",
      kind: "bad"
    });
    register({
      bad: {
        needsSandbox: false,
        run: async () => {
          throw Object.assign(new AppError(400, "X", "Broken."), { result: { big: 10n } });
        }
      },
      badok: { needsSandbox: false, run: async () => ({ result: { big: 10n } }) },
      nothing: { needsSandbox: false, run: async () => ({ result: () => {} }) }
    });
    await run(failing.id);
    expect(await job(failing.id)).toMatchObject({
      status: "failed",
      error: "Broken.",
      result: { resultError: "The job's result could not be saved." }
    });
    const ok = await api.enqueueExtensionJob({
      teamId: team.teamId,
      extension: "demo",
      kind: "badok"
    });
    await run(ok.id);
    expect(await job(ok.id)).toMatchObject({
      status: "completed",
      result: { resultError: "The job's result could not be saved." }
    });
    // A function serializes to nothing rather than throwing.
    const empty = await api.enqueueExtensionJob({
      teamId: team.teamId,
      extension: "demo",
      kind: "nothing"
    });
    await run(empty.id);
    expect(await job(empty.id)).toMatchObject({
      status: "completed",
      result: { resultError: "The job's result could not be saved." }
    });
  });

  it("stamps connection activity only when the handler used the sandbox", async () => {
    register({ copy: { needsSandbox: true, run: async () => ({ result: {} }) } });
    const team = await createTeam("unused");
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      connectionId: team.connectionId,
      extension: "demo",
      kind: "copy"
    });
    await run(id);
    expect((await job(id)).status).toBe("completed");
    const conn = await db.query("SELECT last_used_at FROM qbo_connections WHERE id = $1", [
      team.connectionId
    ]);
    expect(conn.rows[0].last_used_at).toBeNull();
  });

  it("stamps sandbox activity even when the handler fails after using it", async () => {
    vi.spyOn(QboClient.prototype, "request").mockResolvedValue({ QueryResponse: {} });
    register({
      copy: {
        needsSandbox: true,
        run: async (ctx) => {
          await ctx.target.query("select * from Customer");
          throw new AppError(409, "X", "Failed after writing.");
        }
      }
    });
    const team = await createTeam("usedthenfailed");
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      connectionId: team.connectionId,
      extension: "demo",
      kind: "copy"
    });
    await run(id);
    expect((await job(id)).status).toBe("failed");
    const conn = await db.query("SELECT last_used_at FROM qbo_connections WHERE id = $1", [
      team.connectionId
    ]);
    expect(conn.rows[0].last_used_at).not.toBeNull();
  });

  it("counts no sandbox activity for a call refused before anything is sent", async () => {
    const request = vi.spyOn(QboClient.prototype, "request");
    register({
      copy: {
        needsSandbox: true,
        run: async (ctx) => {
          await expect(ctx.target.create("Not An Entity", {})).rejects.toThrow(
            "Invalid QuickBooks entity"
          );
          return { result: {} };
        }
      }
    });
    const team = await createTeam("refusedcall");
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      connectionId: team.connectionId,
      extension: "demo",
      kind: "copy"
    });
    await run(id);
    expect((await job(id)).status).toBe("completed");
    expect(request).not.toHaveBeenCalled();
    const conn = await db.query("SELECT last_used_at FROM qbo_connections WHERE id = $1", [
      team.connectionId
    ]);
    expect(conn.rows[0].last_used_at).toBeNull();
  });

  it("counts no sandbox activity for a call made after the job was cancelled", async () => {
    vi.spyOn(QboClient.prototype, "request").mockRejectedValue(new Error("cancelled"));
    let teamId;
    register({
      copy: {
        needsSandbox: true,
        run: async (ctx) => {
          await api.cancelExtensionJob(teamId, ctx.jobId);
          while (!ctx.signal.aborted) await tick(5);
          await ctx.target.query("select * from Customer").catch(() => {});
          return { result: {} };
        }
      }
    });
    const team = await createTeam("callaftercancel");
    teamId = team.teamId;
    const { id } = await api.enqueueExtensionJob({
      teamId,
      connectionId: team.connectionId,
      extension: "demo",
      kind: "copy"
    });
    await run(id);
    expect((await job(id)).status).toBe("cancelled");
    const conn = await db.query("SELECT last_used_at FROM qbo_connections WHERE id = $1", [
      team.connectionId
    ]);
    expect(conn.rows[0].last_used_at).toBeNull();
  });

  it("lets a call the handler left running finish before the job is ended", async () => {
    let id;
    let statusDuringCall;
    vi.spyOn(QboClient.prototype, "request").mockImplementation(async () => {
      await tick(50);
      statusDuringCall = (await job(id)).status;
      return { QueryResponse: {} };
    });
    register({
      copy: {
        needsSandbox: true,
        run: async (ctx) => {
          ctx.target.query("select * from Customer"); // not awaited
          return { result: {} };
        }
      }
    });
    const team = await createTeam("leftrunning");
    ({ id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      connectionId: team.connectionId,
      extension: "demo",
      kind: "copy"
    }));
    await run(id);
    expect(statusDuringCall).toBe("running");
    expect((await job(id)).status).toBe("completed");
  });

  it("hides an unexpected setup error's details (unreadable stored tokens)", async () => {
    register({ copy: { needsSandbox: true, run: vi.fn() } });
    const team = await createTeam("badtokens");
    await db.query(
      "UPDATE qbo_connections SET access_token_enc = 'zz:zz', refresh_token_enc = 'zz:zz' WHERE id = $1",
      [team.connectionId]
    );
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      connectionId: team.connectionId,
      extension: "demo",
      kind: "copy"
    });
    await run(id);
    expect(await job(id)).toMatchObject({
      status: "failed",
      error: "The job failed. See the server log for details."
    });
  });

  it("refuses calls on a job's target once its handler has ended", async () => {
    vi.spyOn(QboClient.prototype, "request").mockResolvedValue({ QueryResponse: {} });
    let kept;
    register({
      copy: {
        needsSandbox: true,
        run: async (ctx) => {
          kept = ctx.target;
          return { result: {} };
        }
      }
    });
    const team = await createTeam("kepttarget");
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      connectionId: team.connectionId,
      extension: "demo",
      kind: "copy"
    });
    await run(id);
    await expect(kept.query("select * from Customer")).rejects.toThrow(
      "This job has ended; its sandbox can't be used now."
    );
  });

  it("ends a job cancelled just before its handler failed as cancelled, not failed", async () => {
    let teamId;
    register({
      copy: {
        needsSandbox: false,
        run: async (ctx) => {
          await api.cancelExtensionJob(teamId, ctx.jobId);
          throw new AppError(409, "X", "Failed right after the cancel.");
        }
      }
    });
    const team = await createTeam("cancelrace");
    teamId = team.teamId;
    const { id } = await api.enqueueExtensionJob({ teamId, extension: "demo", kind: "copy" });
    // The cancel watcher polls slowly here, so the signal is not aborted when the error arrives.
    await run(id, { cancelPollMs: 60_000 });
    expect((await job(id)).status).toBe("cancelled");
  });

  it("fails a row whose handler is not registered", async () => {
    register({});
    const team = await createTeam("missing");
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      extension: "demo",
      kind: "gone"
    });
    await run(id);
    expect(await job(id)).toMatchObject({
      status: "failed",
      error: "This server cannot run this job (missing extension demo/gone)."
    });
  });

  it("uses the handler's timeoutMinutes instead of the lane default", async () => {
    register({
      slow: {
        needsSandbox: false,
        timeoutMinutes: 2,
        run: async () => {
          await tick(150);
          return { result: {} };
        }
      }
    });
    const team = await createTeam("timeout");
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      extension: "demo",
      kind: "slow"
    });
    expect(await extensionJobTimeoutMs(id)).toBe(2 * 60 * 1000);
    const lane = config.jobs.qboTimeoutMs;
    config.jobs.qboTimeoutMs = 30;
    try {
      await run(id);
    } finally {
      config.jobs.qboTimeoutMs = lane;
    }
    expect((await job(id)).status).toBe("completed");
  });

  it("gives a needsSandbox handler a frozen sandbox target at minor version 75", async () => {
    // No network: the sandbox client's request is replaced and records what it would send.
    const sent = [];
    vi.spyOn(QboClient.prototype, "request").mockImplementation(async function (method, path) {
      sent.push({ method, path, baseUrl: this.baseUrl, minor: this.cfg.qboMinorVersion });
      return { QueryResponse: {} };
    });
    let target;
    let invalid;
    register({
      copy: {
        needsSandbox: true,
        run: async (ctx) => {
          target = ctx.target;
          await ctx.target.query("select * from Customer");
          invalid = await ctx.target.create("../admin", {}).catch((error) => error);
          return { result: {} };
        }
      }
    });
    const team = await createTeam("sandbox");
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      connectionId: team.connectionId,
      extension: "demo",
      kind: "copy"
    });
    await run(id);
    expect((await job(id)).status).toBe("completed");
    expect(Object.isFrozen(target)).toBe(true);
    expect(target.realmId).toBe("realm-sandbox");
    expect(Object.keys(target).sort()).toEqual(
      [
        "realmId",
        "query",
        "read",
        "create",
        "update",
        "remove",
        "batchCreate",
        "batchUpdate",
        "upload",
        "report",
        "preferences",
        "updatePreferences",
        "removeRecurring",
        "clearSandbox"
      ].sort()
    );
    expect(sent).toEqual([
      {
        method: "GET",
        path: "/query",
        baseUrl: "https://sandbox-quickbooks.api.intuit.com",
        minor: "75"
      }
    ]);
    expect(invalid.message).toMatch(/Invalid QuickBooks entity/);
  });

  it("fails a needsSandbox job without a connection before calling the handler", async () => {
    const runFn = vi.fn();
    register({ copy: { needsSandbox: true, run: runFn } });
    const team = await createTeam("noconn");
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      extension: "demo",
      kind: "copy"
    });
    await run(id);
    expect(await job(id)).toMatchObject({
      status: "failed",
      error: "This job needs a sandbox connection."
    });
    expect(runFn).not.toHaveBeenCalled();
  });

  it("keeps extension jobs out of the team's monthly usage and finds them only for their team", async () => {
    register({
      copy: { needsSandbox: false, run: async () => ({ result: {}, entityCount: 500 }) }
    });
    const team = await createTeam("usage");
    const other = await createTeam("usage-other");
    const { id } = await api.enqueueExtensionJob({
      teamId: team.teamId,
      extension: "demo",
      kind: "copy"
    });
    await run(id);
    expect(await getMonthlyUsage(team.teamId)).toEqual({ loads: 0, entities: 0 });
    expect((await api.getExtensionJob(team.teamId, id)).id).toBe(id);
    expect(await api.getExtensionJob(other.teamId, id)).toBeNull();
    expect(await api.getExtensionJob(team.teamId, "not-a-uuid")).toBeNull();
    expect(await api.cancelExtensionJob(other.teamId, id)).toBeNull();
  });
});

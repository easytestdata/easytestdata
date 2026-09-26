import { loadPlanIntoQbo, purgeTransactions, rollbackLoad } from "@easytestdata/qbo-client";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { query, transaction } from "../db/pool.js";
import {
  acquireConnectionLock,
  releaseConnectionLock,
  buildLockedQboClient
} from "../services/connection-lock.js";
import {
  buildPlanFromScenario,
  countPlanEntities,
  normalizeScenarioConfig
} from "../services/scenario-config.js";
import { enforceWorkerExecutionLimits } from "../services/limits.js";
import { getQboCredentials, qboNotConfiguredError } from "../services/app-settings.js";
import {
  removeJobArtifacts,
  writeJobArtifact,
  writeJobArtifacts
} from "../services/job-artifacts.js";

export class JobTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Job timed out after ${Math.round(timeoutMs / 60000)} minute(s) and was stopped.`);
    this.name = "JobTimeoutError";
  }
}

/** Abort reason when the server shuts down while the job runs. */
export class JobShutdownError extends Error {
  constructor() {
    super("Interrupted by a server shutdown.");
    this.name = "JobShutdownError";
  }
}

/** Abort reason when a user or admin cancelled the job (status 'cancelling'). */
export class JobCancelledError extends Error {
  constructor() {
    super("Job was cancelled.");
    this.name = "JobCancelledError";
  }
}

/** Abort reason when an admin force-fails a job that is running in this process. */
export class JobForceFailedError extends Error {
  constructor() {
    super("Force-failed by admin");
    this.name = "JobForceFailedError";
  }
}

// Statuses a job can still move out of. Terminal writes only apply to these, so a job that was
// cancelled (or force-failed by an admin) is never flipped back to completed/failed.
const OPEN_STATUSES = "('pending', 'running', 'cancelling')";
// A job the worker failed at its timeout while the QBO work was still draining. Its own error
// path may still arrive with a ledger; that one late write may upgrade it to failed_with_orphans.
const TIMED_OUT_RESULT = JSON.stringify({ timedOut: true });
const TIMED_OUT_FAILED = "(status = 'failed' AND result->>'timedOut' = 'true')";

// Jobs whose work is still running: jobId -> { controller, run, stopTimeout }, where `run` is the
// underlying runJob promise. An entry stays until that work settles, even after processJob gave
// up on it at its timeout grace, so a shutdown can abort it and wait for its ledger and lock
// release. Once a job times out, `run` also covers processJob's own timeout write, which follows
// the work.
const activeRuns = new Map();

/**
 * Aborts every running job with `reason` and resolves once their work has really stopped. A job
 * stops at its next batch boundary and ends through its normal error path (a load that created
 * records keeps its ledger as failed_with_orphans).
 */
export async function abortAndDrainJobs(reason) {
  for (const { controller, stopTimeout } of activeRuns.values()) {
    stopTimeout();
    controller.abort(reason);
  }
  await Promise.allSettled([...activeRuns.values()].map((e) => e.run));
}

/**
 * Aborts one job's work with `reason` if it runs in this process; returns false otherwise. The job
 * stops at its next batch boundary and ends through its normal error path, which keeps a load's
 * ledger (failed_with_orphans) and releases the connection lock when the work has really stopped.
 */
export function abortRunningJob(jobId, reason) {
  const entry = activeRuns.get(jobId);
  if (!entry) return false;
  entry.controller.abort(reason);
  return true;
}

function parseJobConfig(configValue) {
  if (!configValue) return {};
  if (typeof configValue === "object") return configValue;

  try {
    return JSON.parse(configValue);
  } catch {
    return {};
  }
}

function isCancelled(signal) {
  return Boolean(signal?.aborted && signal.reason instanceof JobCancelledError);
}

/**
 * Persist a failed status and notify listeners, only if the job is still open (so a cancelled
 * job stays cancelled and a job is never failed twice). A failed_with_orphans status set
 * earlier is not open either, so it is preserved. With `upgradeTimedOut`, a job the worker
 * already failed at its timeout (TIMED_OUT_RESULT) may still be upgraded, so the ledger of a
 * load that stopped after the grace period is never lost. Returns whether the job was updated.
 */
async function markJobFailed(jobId, message, options = {}) {
  const { status = "failed", result = null, upgradeTimedOut = false } = options;
  const guard = upgradeTimedOut
    ? `(status IN ${OPEN_STATUSES} OR ${TIMED_OUT_FAILED})`
    : `status IN ${OPEN_STATUSES}`;
  const updated = await query(
    `UPDATE jobs SET status = $1, error = $2, result = COALESCE($3, result), completed_at = NOW()
     WHERE id = $4 AND ${guard}`,
    [status, message, result, jobId]
  );
  return Boolean(updated?.rowCount);
}

/**
 * Whether a load into the same sandbox (QBO realm, through any team's connection), created after
 * `parentJob` (the load being rolled back), may be using the master data (parties, items) it
 * created: loads reuse tagged records. Loads that never touched QBO (pending, cancelled) do not
 * count. Only this yes/no leaves the query, so matching across teams exposes nothing.
 */
export async function laterLoadMayUseMasterData(parentJob) {
  const { rows } = await query(
    `SELECT later.id FROM jobs parent
     JOIN qbo_connections parent_conn ON parent_conn.id = parent.connection_id
     JOIN qbo_connections later_conn ON later_conn.realm_id = parent_conn.realm_id
     JOIN jobs later ON later.connection_id = later_conn.id
     WHERE parent.id = $1 AND later.type = 'load'
       AND later.id <> parent.id AND later.created_at > parent.created_at
       AND later.status IN ('running', 'cancelling', 'completed', 'failed', 'failed_with_orphans')
     LIMIT 1`,
    [parentJob.id]
  );
  return rows.length > 0;
}

/**
 * The worker has stopped a cancelled job. A load that already created records keeps its ledger
 * and becomes failed_with_orphans so it can be rolled back; anything else becomes cancelled.
 * The ledger write also applies to a job the worker already failed at its timeout (a cancel
 * whose in-flight batches drained past the grace period, TIMED_OUT_FAILED), like markJobFailed's
 * `upgradeTimedOut`: whichever terminal path carries the ledger records it.
 */
async function markJobCancelled(jobId, ledger = null) {
  const orphanCount = ledger?.totalTracked || 0;
  if (orphanCount > 0) {
    const message = `Cancelled after ${orphanCount} record(s) were created in QuickBooks. Roll back to remove them.`;
    await query(
      `UPDATE jobs SET status = 'failed_with_orphans', error = $1, result = $2, completed_at = NOW()
       WHERE id = $3 AND (status IN ${OPEN_STATUSES} OR ${TIMED_OUT_FAILED})`,
      [message, JSON.stringify({ ledger }), jobId]
    );
    return;
  }
  await query(
    `UPDATE jobs SET status = 'cancelled', completed_at = NOW()
     WHERE id = $1 AND status IN ${OPEN_STATUSES}`,
    [jobId]
  );
}

/**
 * Mark a job completed if it is still running. Returns whether it was updated. A job that is
 * 'cancelling' is not completed even when the work finished before the abort was seen: the
 * cancel wins, and the caller records the outcome with markJobCancelled (a load's records stay
 * rollback-eligible via its ledger).
 */
// `db` is the client inside a transaction(); the pool otherwise.
async function markJobCompleted(jobId, result, entityCount, db = { query }) {
  const updated = await db.query(
    `UPDATE jobs SET status = 'completed', result = $1, entity_count = $2, completed_at = NOW()
     WHERE id = $3 AND status = 'running'`,
    [JSON.stringify(result), entityCount, jobId]
  );
  return Boolean(updated?.rowCount);
}

/**
 * Poll the job's status while it runs and abort its signal once it is being cancelled, so QBO
 * work stops at the next batch boundary. Returns a function that stops polling.
 */
function watchForCancellation(jobId, controller, pollMs) {
  if (!jobId) return () => {};
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped || controller.signal.aborted) return;
    try {
      const r = await query("SELECT status FROM jobs WHERE id = $1", [jobId]);
      const status = r?.rows?.[0]?.status;
      if (!stopped && (status === "cancelling" || status === "cancelled")) {
        controller.abort(new JobCancelledError());
      }
    } catch (err) {
      logger.warn({ err, jobId }, "Failed to check job cancellation");
    }
  }, pollMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Runs one job row under a hard timeout (`kind` "qbo" or "local" picks it) and a cancellation
 * watch: the AbortSignal stops QBO work at the next batch boundary. A job runs once and is never
 * retried.
 */
export async function processJob({ jobId, kind }, options = {}) {
  const timeoutMs =
    options.timeoutMs ?? (kind === "local" ? config.jobs.localTimeoutMs : config.jobs.qboTimeoutMs);
  const graceMs = options.timeoutGraceMs ?? config.jobs.timeoutGraceMs;
  const controller = new AbortController();
  const stopCancelWatch = watchForCancellation(
    jobId,
    controller,
    options.cancelPollMs ?? config.jobs.cancelPollMs
  );
  let timer;
  const timedOut = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new JobTimeoutError(timeoutMs);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
    timer.unref?.();
  });
  // A shutdown stops the timeout (a cancel keeps it, so a cancel that never drains is still
  // failed at the timeout): its failed write could otherwise land after the drain let the
  // database close.
  const entry = { controller, run: null, stopTimeout: () => clearTimeout(timer) };
  activeRuns.set(jobId, entry);
  const run = runJob(jobId, controller.signal, options);
  entry.run = run;
  const unregister = () => {
    if (activeRuns.get(jobId) === entry) activeRuns.delete(jobId);
  };
  // `entry.run` is read when the work settles: after a timeout it also covers the timeout write.
  run
    .then(
      () => {},
      () => {}
    )
    .then(() => entry.run)
    .then(unregister, unregister);
  try {
    return await Promise.race([run, timedOut]);
  } catch (err) {
    if (err instanceof JobTimeoutError) {
      // The signal is aborted; give runJob's own error path a bounded window to stop at the next
      // batch boundary, persist its ledger (failed_with_orphans, rollback-eligible) and release
      // the connection lock. Failing the row first would leave that ledger write rejected by
      // the terminal-status guard and the lock held after the runner freed the slot.
      const failTimedOut = (async () => {
        const settled = await waitForSettle(run, graceMs);
        if (!settled) {
          logger.error(
            { jobId, graceMs },
            "Job did not stop within the timeout grace period; failing it while it runs"
          );
        }
        // Flagged as timed out so the job's own late error path can still attach its ledger.
        // The connection lock is released by runJob's finally, i.e. when the work really stops.
        await markJobFailed(jobId, err.message, { result: TIMED_OUT_RESULT });
      })();
      // A shutdown drain waits for this write as well as for the work.
      entry.run = Promise.allSettled([run, failTimedOut]);
      await failTimedOut;
      return;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    stopCancelWatch();
  }
}

/** Resolves true once `promise` settles (either way), false if `ms` elapses first. */
function waitForSettle(promise, ms) {
  let timer;
  const elapsed = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  return Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    elapsed
  ]).finally(() => clearTimeout(timer));
}

/**
 * The message a job fails with: the abort reason (timeout, shutdown or admin force-fail) when
 * there is one, else the error.
 */
function failureMessage(signal, err, fallback) {
  if (
    signal?.aborted &&
    (signal.reason instanceof JobTimeoutError ||
      signal.reason instanceof JobShutdownError ||
      signal.reason instanceof JobForceFailedError)
  ) {
    return signal.reason.message;
  }
  return err instanceof Error ? err.message : fallback;
}

async function runJob(jobId, signal, options = {}) {
  const jobResult = await query("SELECT * FROM jobs WHERE id = $1", [jobId]);
  if (jobResult.rows.length === 0) throw new Error(`Job ${jobId} not found`);

  const job = jobResult.rows[0];
  // Only a pending job starts; the atomic claim below decides who runs it. Jobs a previous
  // process left running are closed out by the runner's startup recovery.
  if (job.status !== "pending") return;

  // Progress is read by clients polling the job, so it is written at most once a second. Writes
  // are chained so they land in order, and the latest skipped event is flushed when the work
  // settles, so a finished job never shows an earlier step than its last one.
  let lastProgressDbWrite = 0;
  let unwrittenProgress = null;
  let progressWrites = Promise.resolve();
  const writeProgress = (event) => {
    progressWrites = progressWrites
      .then(() =>
        query("UPDATE jobs SET progress = $1 WHERE id = $2", [JSON.stringify(event), jobId])
      )
      .catch((err) => logger.error({ err, jobId }, "Failed to update job progress"));
    return progressWrites;
  };
  const emit = (event) => {
    const now = Date.now();
    if (now - lastProgressDbWrite > 1000) {
      lastProgressDbWrite = now;
      unwrittenProgress = null;
      writeProgress(event);
    } else {
      unwrittenProgress = event;
    }
  };
  const flushProgress = () => {
    const event = unwrittenProgress;
    unwrittenProgress = null;
    return event ? writeProgress(event) : progressWrites;
  };
  // Runs one progress-emitting QBO operation, then flushes its final progress (either way).
  const withProgress = (operation) => operation.finally(flushProgress);

  // Claim the job; a cancel that landed while it was queued wins.
  const claim = async () => {
    const claimed = await query(
      "UPDATE jobs SET status = 'running', started_at = NOW() WHERE id = $1 AND status = 'pending'",
      [jobId]
    );
    return Boolean(claimed?.rowCount);
  };
  const lockWaitMs = options.lockWaitMs ?? config.jobs.lockWaitMs;

  let connectionLock = null;

  try {
    const parsed = parseJobConfig(job.config);
    const jobConfig = normalizeScenarioConfig(parsed, parsed.templateId);
    let prebuiltPlan = null;
    let estimatedEntities = 0;

    if (job.type !== "purge" && job.type !== "rollback") {
      prebuiltPlan = buildPlanFromScenario(jobConfig);
      estimatedEntities = countPlanEntities(prebuiltPlan.plan.metrics);
    }

    // Every job is re-checked at execution; only loads count toward the monthly load limit.
    try {
      await enforceWorkerExecutionLimits({
        teamId: job.team_id,
        jobId,
        type: job.type,
        estimatedEntities
      });
    } catch (limitErr) {
      const message = limitErr?.message || "Usage limit exceeded.";
      await query(
        `UPDATE jobs SET status = 'failed', error = $1, completed_at = NOW()
         WHERE id = $2 AND status IN ${OPEN_STATUSES}`,
        [message, jobId]
      );
      return;
    }

    // Rollback jobs skip plan building
    if (job.type === "rollback") {
      // Stopped before it started (a shutdown): stay pending and run after the restart.
      if (signal.aborted) return;
      if (!(await claim())) return;

      const parentJobResult = await query("SELECT * FROM jobs WHERE id = $1 AND team_id = $2", [
        job.parent_job_id,
        job.team_id
      ]);
      if (parentJobResult.rows.length === 0) throw new Error("Parent job not found");
      const parentJob = parentJobResult.rows[0];
      const parentResult = parseJobConfig(parentJob.result);
      if (!parentResult?.ledger) throw new Error("No ledger found in parent job");
      const credentials = await getQboCredentials();
      if (!credentials) throw qboNotConfiguredError();

      // Acquire the lock BEFORE reading + building the client so the token
      // ciphertext captured by buildLockedQboClient cannot be rotated by another
      // holder between the SELECT and the lock (matches the load/purge path).
      connectionLock = await acquireConnectionLock(parentJob.connection_id, {
        waitMs: lockWaitMs
      });
      const rollbackConn = await query(
        "SELECT * FROM qbo_connections WHERE id = $1 AND team_id = $2",
        [parentJob.connection_id, job.team_id]
      );
      if (rollbackConn.rows.length === 0) throw new Error("QBO connection not found");
      const rollbackClient = buildLockedQboClient(rollbackConn.rows[0], credentials, { signal });

      // Master data a later load into this sandbox may be using stays active (only this load's
      // transactions are deleted); the report says so and points to Remove test data. Accounts always
      // stay (rollbackLoad).
      const keepMasterData = await laterLoadMayUseMasterData(parentJob);
      const report = await withProgress(
        rollbackLoad(rollbackClient, parentResult.ledger, emit, signal, { keepMasterData })
      );

      // Transactions are deleted, master data made inactive (QBO cannot delete it). Some
      // records could not be removed: the rollback failed (with its report), and the load stays
      // failed_with_orphans so it can be rolled back again. A retry skips what is gone.
      const rolledBack = (report.totalDeleted || 0) + (report.totalInactivated || 0);
      const failedCount = report.failures?.length || 0;
      if (failedCount > 0) {
        const message =
          `Rolled back ${rolledBack} records; ${failedCount} could not be ` +
          "deleted or made inactive. You can retry the rollback.";
        if (!(await markJobFailed(jobId, message, { result: JSON.stringify(report) }))) {
          await markJobCancelled(jobId);
        }
        return;
      }

      // The rollback completes and its load leaves failed_with_orphans in one transaction: a
      // crash between the two writes must not leave a completed rollback (which blocks every
      // retry) next to a load that still reports orphans.
      const completed = await transaction(async (client) => {
        if (!(await markJobCompleted(jobId, report, rolledBack, client))) return false;
        await client.query(
          "UPDATE jobs SET status = 'failed' WHERE id = $1 AND status = 'failed_with_orphans'",
          [job.parent_job_id]
        );
        return true;
      });
      if (!completed) await markJobCancelled(jobId);
      return;
    }

    // Stopped before it started (a shutdown): stay pending and run after the restart.
    if (signal.aborted) return;
    if (!(await claim())) return;

    if (job.type === "generate" || job.type === "export") {
      const plan = prebuiltPlan.plan;
      // The requested format becomes the primary artifact; JSON and CSV are both written so
      // either can be downloaded from the job detail view. A timeout or cancel stops the writing
      // (the files are removed) and the job ends through the error path below.
      const { artifact, artifacts } = await writeJobArtifacts(
        jobId,
        plan,
        String(jobConfig.exportFormat || "json"),
        { signal }
      );
      const entityCount = estimatedEntities;

      if (
        !(await markJobCompleted(
          jobId,
          { metrics: plan.metrics, meta: plan.meta, artifact, artifacts },
          entityCount
        ))
      ) {
        await markJobCancelled(jobId);
        return;
      }

      return;
    }

    // Load and purge need the Intuit app keys (the job fails with the setup hint without them).
    const credentials = await getQboCredentials();
    if (!credentials) throw qboNotConfiguredError();

    if (job.connection_id) {
      connectionLock = await acquireConnectionLock(job.connection_id, { waitMs: lockWaitMs });
    }

    const conn = await query("SELECT * FROM qbo_connections WHERE id = $1 AND team_id = $2", [
      job.connection_id,
      job.team_id
    ]);
    if (conn.rows.length === 0) throw new Error("QBO connection not found");
    const qboConn = conn.rows[0];

    // Pre-flight: check token expiry (QBO refresh tokens expire after 100 days of non-use)
    const lastActivity = qboConn.last_used_at || qboConn.connected_at;
    if (lastActivity) {
      const daysSince = Math.floor(
        (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24)
      );
      if (daysSince > 100) {
        const msg =
          "QBO connection has expired (>100 days inactive). Please reconnect your sandbox at Settings → Connections.";
        await markJobFailed(jobId, msg);
        return;
      }
    }

    const client = buildLockedQboClient(qboConn, credentials, { signal });

    if (job.type === "load") {
      // Purge existing data first if requested
      if (jobConfig.purgeMode === "generated" || jobConfig.purgeMode === "all") {
        const purgeLabel = jobConfig.purgeMode === "all" ? "all" : "generated";
        emit({
          step: 0,
          totalSteps: 1,
          message:
            purgeLabel === "all"
              ? "Erasing all data first..."
              : "Removing existing test data first..."
        });
        try {
          await withProgress(
            purgeTransactions(
              client,
              { mode: jobConfig.purgeMode, tag: jobConfig.tag },
              (event) => emit({ ...event, message: `[Removing old data] ${event.message || ""}` }),
              signal
            )
          );
          emit({ step: 1, totalSteps: 1, message: "Existing data cleared. Starting load..." });
        } catch (purgeErr) {
          if (isCancelled(signal)) {
            await markJobCancelled(jobId);
            return;
          }
          const msg = `Pre-load purge failed: ${failureMessage(signal, purgeErr, "Unknown error")}`;
          await markJobFailed(jobId, msg);
          return;
        }
      }

      const { plan, resolvedConfig } = prebuiltPlan;
      let result;
      try {
        result = await withProgress(loadPlanIntoQbo(client, plan, resolvedConfig, emit, signal));
      } catch (loadErr) {
        // Store ledger for potential rollback
        const ledger = loadErr.ledger || null;
        if (isCancelled(signal)) {
          await markJobCancelled(jobId, ledger);
          return;
        }
        const status = ledger && ledger.totalTracked > 0 ? "failed_with_orphans" : "failed";
        const message = failureMessage(signal, loadErr, "Load failed");
        await markJobFailed(jobId, message, {
          status,
          result: ledger ? JSON.stringify({ ledger }) : null,
          // A load that outlived the timeout grace was already failed; its ledger still counts.
          upgradeTimedOut: status === "failed_with_orphans"
        });
        return;
      }

      // Every record now exists in QBO: from here on a failure must keep the ledger so the
      // load stays rollback-eligible. The JSON artifact is a convenience copy of the plan; the
      // load still completes without it (and says so). The write honours the job's signal, so a
      // stalled disk cannot hold the run (and its connection lock) past a timeout, shutdown or
      // cancel: the partial file is removed and the finished load is still recorded below.
      let artifact = null;
      let artifactError;
      try {
        artifact = await writeJobArtifact(jobId, plan, "json", { signal });
      } catch (err) {
        if (signal.aborted) {
          logger.warn({ err, jobId }, "Load succeeded but its JSON artifact write was stopped");
          artifactError =
            "The plan file was not saved because the job was stopped; the data was loaded.";
          try {
            await removeJobArtifacts(jobId);
          } catch (rmErr) {
            logger.warn({ err: rmErr, jobId }, "Could not remove a partial load artifact");
          }
        } else {
          logger.warn({ err, jobId }, "Load succeeded but its JSON artifact could not be written");
          artifactError = "The plan file could not be saved; the data was loaded.";
        }
      }
      const entityCount = estimatedEntities;
      let marked;
      try {
        await query("UPDATE qbo_connections SET last_used_at = NOW() WHERE id = $1", [qboConn.id]);
        marked = await markJobCompleted(
          jobId,
          {
            ...result,
            artifact,
            ...(artifactError ? { artifactError } : {}),
            metrics: plan.metrics,
            meta: plan.meta
          },
          entityCount
        );
      } catch (finalizeErr) {
        const ledger = result?.ledger || null;
        const status = ledger && ledger.totalTracked > 0 ? "failed_with_orphans" : "failed";
        await markJobFailed(
          jobId,
          `Data was loaded but the job could not be finalized: ${finalizeErr.message}`,
          {
            status,
            result: ledger ? JSON.stringify({ ledger }) : null,
            upgradeTimedOut: status === "failed_with_orphans"
          }
        );
        return;
      }
      if (!marked) {
        // Cancelled while the last batches landed: the records exist, so keep the ledger and
        // leave the job rollback-eligible instead of reporting it as completed.
        await markJobCancelled(jobId, result?.ledger || null);
        return;
      }

      return;
    }

    if (job.type === "purge") {
      // A scenario's purgeMode is its load-time setting ("none" = don't clear before loading);
      // a purge job clears generated data unless the scenario asks for "all".
      const purgeMode = jobConfig.purgeMode === "all" ? "all" : "generated";
      const report = await withProgress(
        purgeTransactions(client, { mode: purgeMode, tag: jobConfig.tag }, emit, signal)
      );
      await query("UPDATE qbo_connections SET last_used_at = NOW() WHERE id = $1", [qboConn.id]);
      if (!(await markJobCompleted(jobId, report, Number(report.deletedTotal || 0)))) {
        await markJobCancelled(jobId);
        return;
      }

      return;
    }

    throw new Error(`Unsupported job type: ${job.type}`);
  } catch (err) {
    if (isCancelled(signal)) {
      await markJobCancelled(jobId);
      return;
    }
    const message = failureMessage(signal, err, "Job failed");
    await markJobFailed(jobId, message);
    throw err;
  } finally {
    await releaseConnectionLock(connectionLock);
  }
}

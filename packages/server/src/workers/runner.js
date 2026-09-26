import { config } from "../config.js";
import { logger } from "../logger.js";
import { query } from "../db/pool.js";
import { abortAndDrainJobs, JobShutdownError, processJob } from "./index.js";
import { refreshExpiringTokens } from "./token-refresh.js";
import { cleanupExpiredArtifacts } from "../services/job-artifacts.js";

export const QBO_JOB_TYPES = ["load", "purge", "rollback"];
export const LOCAL_JOB_TYPES = ["generate", "export"];

let wake = () => {};
/** Wake the runner now instead of at its next poll (no-op before it starts or after it stops). */
export function notifyJobQueued() {
  wake();
}

const CLEAR_DATA_HINT = 'Records it created may remain; use "Remove test data" to delete them.';

/**
 * Closes out jobs a previous process left running/cancelling. Returns how many. Both carry the
 * Remove test data hint: the ledger of what a load created lived only in that process's memory, so the
 * records stay in the sandbox and the load can no longer be rolled back.
 */
export async function recoverInterruptedJobs() {
  const result = await query(
    `UPDATE jobs
     SET status = CASE WHEN status = 'cancelling' THEN 'cancelled' ELSE 'failed' END,
         error = CASE WHEN status = 'cancelling' THEN $1 ELSE $2 END,
         completed_at = NOW()
     WHERE status IN ('running', 'cancelling')`,
    [
      `Cancelled while the server restarted. ${CLEAR_DATA_HINT}`,
      `Interrupted by a server restart. ${CLEAR_DATA_HINT}`
    ]
  );
  return result.rowCount || 0;
}

/**
 * Recovers interrupted jobs, then starts dispatching. Resolves to { stop() } once recovery is
 * done, so no job can start before it. stop() stops claiming, waits for an in-progress poll,
 * then gives running jobs and any running maintenance task up to drainMs (the maintenance signal
 * is aborted first, so the token keepalive starts no further refresh), then aborts and drains the
 * jobs, and never dispatches afterwards.
 */
export async function startJobRunner({
  qboConcurrency = config.jobs.qboConcurrency,
  localConcurrency = config.jobs.localConcurrency,
  pollMs = config.jobs.pollMs,
  drainMs = 15_000,
  process = processJob,
  maintenanceMs = { tokenRefresh: 86_400_000, artifactCleanup: 6 * 3_600_000 }
} = {}) {
  const recovered = await recoverInterruptedJobs();
  if (recovered) logger.warn({ count: recovered }, "Closed out jobs interrupted by a restart");

  const inFlight = new Map();
  const lanes = [
    { kind: "qbo", types: QBO_JOB_TYPES, limit: qboConcurrency, running: 0 },
    { kind: "local", types: LOCAL_JOB_TYPES, limit: localConcurrency, running: 0 }
  ];
  let stopped = false;
  let timer = null;
  let polling = null;

  const schedule = (ms) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => void poll(), ms);
    timer.unref?.();
  };

  function dispatch(lane, id) {
    lane.running += 1;
    const run = Promise.resolve()
      .then(() => process({ jobId: id, kind: lane.kind }))
      .catch((err) => logger.error({ err, jobId: id }, "Job failed"))
      .finally(() => {
        lane.running -= 1;
        inFlight.delete(id);
        schedule(0);
      });
    inFlight.set(id, run);
  }

  async function poll() {
    if (stopped || polling) return;
    polling = (async () => {
      for (const lane of lanes) {
        const free = lane.limit - lane.running;
        if (free <= 0) continue;
        const { rows } = await query(
          `SELECT id FROM jobs
           WHERE status = 'pending' AND type = ANY($1) AND NOT (id = ANY($2::uuid[]))
           ORDER BY created_at, id
           LIMIT $3`,
          [lane.types, [...inFlight.keys()], free]
        );
        if (stopped) return; // stop() ran while we were querying: dispatch nothing
        for (const { id } of rows) dispatch(lane, id);
      }
    })()
      .catch((err) => logger.error({ err }, "Job runner poll failed"))
      .finally(() => {
        polling = null;
        schedule(pollMs);
      });
    await polling;
  }

  // Maintenance runs are tracked so stop() waits for them; a failure is logged, never thrown.
  // stop() aborts `maintenanceAbort` first: a task that takes the signal stops starting work.
  const maintenanceRuns = new Set();
  const maintenanceAbort = new AbortController();
  const runMaintenance = (label, task) => {
    if (stopped) return;
    const run = Promise.resolve()
      .then(task)
      .catch((err) => logger.error({ err }, `${label} failed`))
      .finally(() => maintenanceRuns.delete(run));
    maintenanceRuns.add(run);
  };
  const every = (ms, label, task) => {
    const t = setInterval(() => runMaintenance(label, task), ms);
    t.unref?.();
    return t;
  };
  const cleanupArtifacts = () => cleanupExpiredArtifacts({ ttlDays: config.jobs.artifactTtlDays });
  const refreshTokens = () => refreshExpiringTokens({ signal: maintenanceAbort.signal });
  const maintenance = [
    every(maintenanceMs.tokenRefresh, "Token refresh", refreshTokens),
    every(maintenanceMs.artifactCleanup, "Artifact cleanup", cleanupArtifacts)
  ];
  // Every task also runs once now, in the background (after recovery; dispatch does not wait): a
  // process restarted more often than an interval would otherwise never run it, so a sandbox near
  // the 100-day token expiry could lapse, and expired exports would never be deleted.
  runMaintenance("Token refresh", refreshTokens);
  runMaintenance("Artifact cleanup", cleanupArtifacts);

  wake = () => schedule(0);
  schedule(0);
  logger.info({ qboConcurrency, localConcurrency }, "Job runner started");

  return {
    async stop() {
      stopped = true;
      wake = () => {};
      clearTimeout(timer);
      for (const t of maintenance) clearInterval(t);
      maintenanceAbort.abort();
      if (polling) await polling;
      // Nothing may write after the database closes. Maintenance and jobs get drainMs to finish
      // on their own: the token keepalive, told to stop, ends after the Intuit call it has in
      // flight (whose rotated token it persists) and starts no other; a run still going after
      // that (a startup keepalive over many sandboxes, one slow Intuit call) is not waited for
      // beyond drainMs, and any token it rotates from then on is not stored (the persist fails
      // and is logged). Jobs are then aborted and awaited until their underlying work has really
      // stopped (ledgers and tokens persisted).
      let drainTimer;
      await Promise.race([
        Promise.allSettled([...maintenanceRuns, ...inFlight.values()]),
        new Promise((resolve) => (drainTimer = setTimeout(resolve, drainMs)))
      ]);
      clearTimeout(drainTimer);
      if (maintenanceRuns.size > 0) {
        logger.warn(
          { drainMs },
          "Maintenance still running at shutdown; a QBO token it rotates from now on is not stored"
        );
      }
      await abortAndDrainJobs(new JobShutdownError());
    }
  };
}

import { createServer } from "http";
import { pathToFileURL } from "url";
import * as Sentry from "@sentry/node";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { collectStartupProblems } from "./startup-checks.js";
import { runMigrations } from "./db/migrate.js";
import { closeDatabase, lockDatabase } from "./db/pool.js";
import { createApp } from "./server.js";
import { startJobRunner } from "./workers/runner.js";
import { bootstrapAdminsAtStartup } from "./services/admin-bootstrap.js";
import { ensureLocalSecrets } from "./local/secrets.js";
import { ensureLocalIdentity } from "./local/identity.js";
import { lockDataDir } from "./local/instance-lock.js";
import { getQboCredentials } from "./services/app-settings.js";
import { scrubSentryEvent } from "./http/setup.js";

/** Refuses unsafe configuration (exits) and sets up optional integrations before anything runs. */
function checkStartupConfig() {
  const { fatal, warnings } = collectStartupProblems(process.env);
  for (const warning of warnings) logger.warn(warning);
  if (fatal.length > 0) {
    for (const problem of fatal) logger.fatal(problem);
    process.exit(1);
  }
  // Sentry (only when DSN is configured)
  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: config.nodeEnv,
      tracesSampleRate: config.nodeEnv === "production" ? 0.1 : 1.0,
      beforeSend: scrubSentryEvent,
      beforeSendTransaction: scrubSentryEvent
    });
  }
}

/**
 * Warns when no Intuit app keys are set (read after migrations: local mode may store them). Only a
 * warning: it never stops the server from starting.
 */
async function warnIfQboNotConfigured(local) {
  try {
    if (await getQboCredentials()) return;
  } catch (err) {
    logger.warn({ err }, "Could not check whether Intuit app keys are set");
    return;
  }
  logger.warn(
    { redirectUri: config.qbo.redirectUri },
    local
      ? "No Intuit app keys yet — generating and downloading data works; to connect a QuickBooks " +
          "Online sandbox, add your Intuit developer app's keys on the setup page and register " +
          "this redirect URI."
      : "QBO_CLIENT_ID / QBO_CLIENT_SECRET not set — connecting QuickBooks Online sandboxes is " +
          "disabled. Create an Intuit developer app, copy its sandbox keys into .env, and " +
          "register this redirect URI."
  );
}

/**
 * Local mode: creates the data dir (0700) and its secret key file on first run, and uses them
 * unless JWT_SECRET / TOKEN_ENCRYPTION_KEY are set.
 */
function applyLocalSecrets() {
  const secrets = ensureLocalSecrets(config.dataDir);
  if (!process.env.JWT_SECRET) config.jwt.secret = secrets.jwtSecret;
  if (!process.env.TOKEN_ENCRYPTION_KEY) config.tokenEncryption.key = secrets.encryptionKey;
}

/**
 * One server per database: a second one (e.g. started twice by mistake) must not migrate, close
 * out the first one's running jobs as "interrupted", or open PGlite's files alongside it. Local
 * mode locks the data dir, Cloud takes a Postgres advisory lock (onLost runs if its connection
 * drops). Returns { release() }.
 */
async function acquireServerLock(local, onLost) {
  if (local) return lockDataDir(config.dataDir);
  const lock = await lockDatabase({ onLost });
  if (!lock) {
    throw new Error("Another EasyTestData server is already running against this database.");
  }
  return lock;
}

/**
 * Runs every shutdown step even when an earlier one fails, so the database is closed (and the
 * caller then releases the lock) whatever happened before. Rethrows the first failure; later
 * ones are logged.
 */
async function runEveryStep(steps) {
  let failure = null;
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      if (failure) logger.error({ err }, "Shutdown step failed");
      else failure = err;
    }
  }
  if (failure) throw failure;
}

const closeServer = (server) => new Promise((resolve) => server.close(() => resolve()));

/**
 * Starts the server: (local mode: data dir and secrets), the single-server lock, migrations,
 * (local mode: the built-in user and team), then the job runner (which first closes out jobs a
 * previous process left running), then the HTTP server, on 127.0.0.1 only in local mode.
 * Resolves { server, close }; close() stops accepting connections, stops the runner (running
 * jobs are drained, then aborted and awaited), closes the database (even if stopping the runner
 * failed; the first error is rethrown) and only then releases the single-server lock. A startup that fails after taking the lock stops whatever it started,
 * closes the database and releases the lock. Cloud: if the lock's connection is lost, another
 * server could start, so this one shuts down: close(), then exit(1) (during startup, the startup
 * fails instead).
 */
export async function bootstrap({ listen = true, exit = (code) => process.exit(code) } = {}) {
  checkStartupConfig();
  const local = config.deployment === "local";
  if (local) applyLocalSecrets(); // creates the data dir the local lock lives in
  let lockLost = null;
  let close = null;
  const lock = await acquireServerLock(local, (err) => {
    logger.error({ err }, "Lost the single-server database lock: shutting down");
    lockLost = err;
    if (close) {
      close().then(
        () => exit(1),
        (closeErr) => {
          logger.error({ err: closeErr }, "Shutdown failed");
          exit(1);
        }
      );
    }
  });
  let runner = null;
  let server;
  try {
    await runMigrations({ closePool: false });
    if (local) await ensureLocalIdentity();
    await warnIfQboNotConfigured(local);
    // A lost lock means another server may already run: never recover its jobs or start ours.
    if (lockLost) throw lockLost;
    runner = await startJobRunner();

    // ADMIN_EMAILS: make matching existing users admins (Cloud only; local mode has no admins).
    if (!local) {
      bootstrapAdminsAtStartup().catch((err) =>
        logger.error({ err }, "ADMIN_EMAILS bootstrap failed")
      );
    }

    server = createServer(createApp());
    if (lockLost) throw lockLost;
    if (listen) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      logger.info({ host: config.host, port: config.port }, "EasyTestData server running");
    }
    if (lockLost) throw lockLost;
  } catch (err) {
    // e.g. a failed migration or a taken port: stop any job the runner already started, close
    // the database (releasing PGlite's data dir), then the lock, before giving up. The startup
    // error is the one rethrown; the database is closed and the lock released even if a
    // cleanup step fails.
    try {
      await runEveryStep([
        async () => {
          if (runner) await runner.stop();
        },
        async () => {
          if (server?.listening) await closeServer(server);
        },
        () => closeDatabase()
      ]);
    } catch (cleanupErr) {
      logger.error({ err: cleanupErr }, "Cleanup after a failed start failed");
    } finally {
      await lock.release();
    }
    throw err;
  }

  let closing = null;
  close = () => {
    closing ??= (async () => {
      try {
        await runEveryStep([
          async () => {
            if (!server.listening) return;
            await closeServer(server);
            logger.info("HTTP server closed");
          },
          async () => {
            await runner.stop();
            logger.info("Job runner stopped");
          },
          async () => {
            await closeDatabase();
            logger.info("Database closed");
          }
        ]);
      } finally {
        await lock.release();
      }
    })();
    return closing;
  };

  return { server, close };
}

/**
 * SIGTERM/SIGINT: the first stops the server cleanly (close(), then exit 0). A second one while
 * that is still running exits 1 at once; startup recovery closes out any job it interrupts.
 */
export function handleShutdownSignals(
  close,
  {
    exit = (code) => process.exit(code),
    onSignal = (signal, handler) => process.on(signal, handler)
  } = {}
) {
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) {
      logger.warn({ signal }, "Second shutdown signal: exiting now without waiting for jobs");
      exit(1);
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "Shutdown signal received, stopping...");
    close().then(
      () => exit(0),
      (err) => {
        logger.error({ err }, "Shutdown failed");
        exit(1);
      }
    );
  };
  onSignal("SIGTERM", () => shutdown("SIGTERM"));
  onSignal("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrap()
    .then(({ close }) => handleShutdownSignals(close))
    .catch((err) => {
      logger.fatal({ err }, "Failed to start EasyTestData");
      process.exit(1);
    });
}

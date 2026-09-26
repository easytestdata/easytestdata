import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  order: [],
  migrate: null,
  duringMigrate: null,
  duringCreateApp: null,
  locked: true,
  onLost: null,
  closeDbError: null,
  runnerStopError: null
}));
const serverLock = vi.hoisted(() => ({
  release: vi.fn(async () => calls.order.push("lock.release"))
}));
vi.mock("../src/db/migrate.js", () => ({
  runMigrations: vi.fn(async (options) => {
    calls.order.push(`migrate:${options.closePool}`);
    calls.duringMigrate?.();
    if (calls.migrate) throw calls.migrate;
  })
}));
vi.mock("../src/db/pool.js", () => ({
  closeDatabase: vi.fn(async () => {
    calls.order.push("closeDatabase");
    if (calls.closeDbError) throw calls.closeDbError;
  }),
  // Cloud's single-server advisory lock; null = another server holds it.
  lockDatabase: vi.fn(async ({ onLost }) => {
    calls.order.push("lock");
    calls.onLost = onLost;
    return calls.locked ? serverLock : null;
  }),
  query: vi.fn(async () => ({ rows: [], rowCount: 0 }))
}));
vi.mock("../src/workers/runner.js", () => ({
  startJobRunner: vi.fn(async () => {
    calls.order.push("runner.start");
    return {
      stop: vi.fn(async () => {
        calls.order.push("runner.stop");
        if (calls.runnerStopError) throw calls.runnerStopError;
      })
    };
  })
}));
vi.mock("../src/server.js", () => ({
  createApp: vi.fn(() => {
    calls.order.push("createApp");
    calls.duringCreateApp?.();
    return (_req, res) => res.end();
  })
}));
vi.mock("../src/services/admin-bootstrap.js", () => ({
  bootstrapAdminsAtStartup: vi.fn(async () => {})
}));
// Local-mode cases never touch a real data dir (~/.easytestdata) or identity rows.
vi.mock("../src/local/secrets.js", () => ({
  ensureLocalSecrets: vi.fn(() => ({ jwtSecret: "j".repeat(64), encryptionKey: "ab".repeat(32) }))
}));
vi.mock("../src/local/identity.js", () => ({ ensureLocalIdentity: vi.fn(async () => ({})) }));
vi.mock("../src/local/instance-lock.js", () => ({
  lockDataDir: vi.fn(() => {
    calls.order.push("lock");
    return serverLock;
  })
}));
const sentryInit = vi.hoisted(() => vi.fn());
vi.mock("@sentry/node", () => ({ init: sentryInit }));
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
}));

const { bootstrap, handleShutdownSignals } = await import("../src/start.js");

describe("bootstrap", () => {
  beforeEach(() => {
    calls.order = [];
    calls.migrate = null;
    calls.duringMigrate = null;
    calls.duringCreateApp = null;
    calls.locked = true;
    calls.onLost = null;
    calls.closeDbError = null;
    calls.runnerStopError = null;
  });

  it("takes the single-server lock, runs migrations, starts the job runner, builds the app", async () => {
    await bootstrap({ listen: false });
    expect(calls.order).toEqual(["lock", "migrate:false", "runner.start", "createApp"]);
  });

  it("scrubs both Sentry error events and transactions when a DSN is set", async () => {
    const { scrubSentryEvent } = await import("../src/http/setup.js");
    vi.stubEnv("SENTRY_DSN", "https://key@sentry.example/1");
    try {
      await bootstrap({ listen: false });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(sentryInit).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeSend: scrubSentryEvent,
        beforeSendTransaction: scrubSentryEvent
      })
    );
  });

  it("refuses to start while another server holds the database lock, touching nothing", async () => {
    const { createApp } = await import("../src/server.js");
    createApp.mockClear();
    const { config } = await import("../src/config.js");
    const saved = { port: config.port, host: config.host };
    Object.assign(config, { port: 28191, host: "127.0.0.1" }); // never the default :3000
    calls.locked = false;
    try {
      await expect(bootstrap({ listen: true })).rejects.toThrow(
        "Another EasyTestData server is already running against this database."
      );
    } finally {
      Object.assign(config, saved);
    }
    // No migration, no restart recovery (the runner's first step), no listening socket.
    expect(calls.order).toEqual(["lock"]);
    expect(createApp).not.toHaveBeenCalled();
  });

  it("takes the local data-dir lock after the data dir exists and before migrations", async () => {
    const { config } = await import("../src/config.js");
    const { ensureLocalSecrets } = await import("../src/local/secrets.js");
    const { lockDataDir } = await import("../src/local/instance-lock.js");
    const original = config.deployment;
    config.deployment = "local";
    ensureLocalSecrets.mockImplementationOnce(() => {
      calls.order.push("secrets");
      return { jwtSecret: "j".repeat(64), encryptionKey: "ab".repeat(32) };
    });
    try {
      await bootstrap({ listen: false });
      expect(calls.order.slice(0, 3)).toEqual(["secrets", "lock", "migrate:false"]);
      expect(lockDataDir).toHaveBeenCalledWith(config.dataDir);
    } finally {
      config.deployment = original;
    }
  });

  it("warns (after migrations) when no Intuit app keys are set, and not when they are", async () => {
    const { logger } = await import("../src/logger.js");
    vi.stubEnv("QBO_CLIENT_ID", "");
    vi.stubEnv("QBO_CLIENT_SECRET", "");
    logger.warn.mockClear();
    await bootstrap({ listen: false });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: expect.stringContaining("/api/v1/connections/callback")
      }),
      expect.stringContaining("QBO_CLIENT_ID")
    );

    vi.stubEnv("QBO_CLIENT_ID", "id");
    vi.stubEnv("QBO_CLIENT_SECRET", "secret");
    logger.warn.mockClear();
    await bootstrap({ listen: false });
    expect(logger.warn).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("names the setup page in local mode's missing-keys warning", async () => {
    const { logger } = await import("../src/logger.js");
    const { config } = await import("../src/config.js");
    const original = config.deployment;
    vi.stubEnv("QBO_CLIENT_ID", "");
    vi.stubEnv("QBO_CLIENT_SECRET", "");
    config.deployment = "local";
    logger.warn.mockClear();
    try {
      await bootstrap({ listen: false });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ redirectUri: expect.any(String) }),
        expect.stringContaining("on the setup page")
      );
    } finally {
      config.deployment = original;
      vi.unstubAllEnvs();
    }
  });

  it("starts even when checking for Intuit keys fails", async () => {
    const { query } = await import("../src/db/pool.js");
    const { config } = await import("../src/config.js");
    const original = config.deployment;
    vi.stubEnv("QBO_CLIENT_ID", "");
    config.deployment = "local";
    query.mockRejectedValueOnce(new Error("database gone"));
    try {
      await expect(bootstrap({ listen: false })).resolves.toHaveProperty("close");
    } finally {
      config.deployment = original;
      vi.unstubAllEnvs();
    }
  });

  it("close() stops the runner, closes the database, then releases the server lock", async () => {
    const { close } = await bootstrap({ listen: false });
    calls.order = [];
    await close();
    await close(); // a second signal does not stop anything twice
    expect(calls.order).toEqual(["runner.stop", "closeDatabase", "lock.release"]);
  });

  it("stops the runner and closes the database when the port is taken", async () => {
    const { createServer } = await import("node:net");
    const { config } = await import("../src/config.js");
    const saved = { port: config.port, host: config.host };
    const blocker = createServer();
    await new Promise((resolve) => blocker.listen(28188, "127.0.0.1", resolve));
    Object.assign(config, { port: 28188, host: "127.0.0.1" });
    try {
      await expect(bootstrap({ listen: true })).rejects.toThrow(/EADDRINUSE/);
      expect(calls.order.slice(-3)).toEqual(["runner.stop", "closeDatabase", "lock.release"]);
    } finally {
      Object.assign(config, saved);
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it("shuts down (close(), then exit 1) when the database lock's connection is lost", async () => {
    const exit = vi.fn();
    await bootstrap({ listen: false, exit });
    calls.order = [];
    calls.onLost(new Error("connection terminated"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(calls.order).toEqual(["runner.stop", "closeDatabase", "lock.release"]);
  });

  it("fails the startup before recovery or the runner when the lock is lost while migrating", async () => {
    const exit = vi.fn();
    calls.duringMigrate = () => calls.onLost(new Error("connection terminated"));
    await expect(bootstrap({ listen: false, exit })).rejects.toThrow("connection terminated");
    // startJobRunner (whose first step is recoverInterruptedJobs) never ran.
    expect(calls.order).toEqual(["lock", "migrate:false", "closeDatabase", "lock.release"]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("never listens when the lock is lost after the runner started", async () => {
    const { logger } = await import("../src/logger.js");
    const { config } = await import("../src/config.js");
    const saved = { port: config.port, host: config.host };
    Object.assign(config, { port: 28191, host: "127.0.0.1" }); // never the default :3000
    logger.info.mockClear();
    const exit = vi.fn();
    calls.duringCreateApp = () => calls.onLost(new Error("connection terminated"));
    try {
      await expect(bootstrap({ listen: true, exit })).rejects.toThrow("connection terminated");
    } finally {
      Object.assign(config, saved);
    }
    expect(calls.order.slice(-3)).toEqual(["runner.stop", "closeDatabase", "lock.release"]);
    expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), "EasyTestData server running");
    expect(exit).not.toHaveBeenCalled();
  });

  it("releases the lock and rethrows the startup error even when cleanup fails", async () => {
    calls.migrate = new Error("migration failed");
    calls.closeDbError = new Error("close failed");
    await expect(bootstrap({ listen: false })).rejects.toThrow("migration failed");
    expect(calls.order).toEqual(["lock", "migrate:false", "closeDatabase", "lock.release"]);
  });

  it("close() releases the lock even when closing the database fails", async () => {
    const { close } = await bootstrap({ listen: false });
    calls.order = [];
    calls.closeDbError = new Error("close failed");
    await expect(close()).rejects.toThrow("close failed");
    expect(calls.order).toEqual(["runner.stop", "closeDatabase", "lock.release"]);
  });

  it("close() still closes the database, then releases the lock, when stopping the runner fails", async () => {
    const { close } = await bootstrap({ listen: false });
    calls.order = [];
    calls.runnerStopError = new Error("drain failed");
    await expect(close()).rejects.toThrow("drain failed");
    expect(calls.order).toEqual(["runner.stop", "closeDatabase", "lock.release"]);
  });

  it("close() surfaces the runner's error when closing the database fails too", async () => {
    const { logger } = await import("../src/logger.js");
    logger.error.mockClear();
    const { close } = await bootstrap({ listen: false });
    calls.runnerStopError = new Error("drain failed");
    calls.closeDbError = new Error("close failed");
    await expect(close()).rejects.toThrow("drain failed");
    expect(logger.error).toHaveBeenCalledWith({ err: calls.closeDbError }, expect.any(String));
  });

  it("closes the database after a failed start even when stopping the runner fails", async () => {
    calls.duringCreateApp = () => {
      throw new Error("app failed");
    };
    calls.runnerStopError = new Error("drain failed");
    await expect(bootstrap({ listen: false })).rejects.toThrow("app failed");
    expect(calls.order.slice(-3)).toEqual(["runner.stop", "closeDatabase", "lock.release"]);
  });

  it("never starts the job runner when migrations fail, and releases the lock", async () => {
    calls.migrate = new Error("migration failed");
    await expect(bootstrap({ listen: false })).rejects.toThrow("migration failed");
    expect(calls.order).toEqual(["lock", "migrate:false", "closeDatabase", "lock.release"]);
  });
});

describe("shutdown signals", () => {
  function setup(close) {
    const handlers = {};
    const exit = vi.fn();
    handleShutdownSignals(close, {
      exit,
      onSignal: (signal, handler) => (handlers[signal] = handler)
    });
    return { handlers, exit };
  }

  it("closes on the first signal and exits 0 once close() is done", async () => {
    let finishClose;
    const close = vi.fn(() => new Promise((resolve) => (finishClose = resolve)));
    const { handlers, exit } = setup(close);

    handlers.SIGTERM();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    finishClose();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("exits 1 at once on a second signal while close() is still running", () => {
    const close = vi.fn(() => new Promise(() => {})); // e.g. a load still draining
    const { handlers, exit } = setup(close);

    handlers.SIGINT();
    handlers.SIGINT();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits 1 when close() fails", async () => {
    const { handlers, exit } = setup(vi.fn(async () => Promise.reject(new Error("boom"))));
    handlers.SIGTERM();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});

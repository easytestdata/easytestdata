import { beforeEach, describe, expect, it, vi } from "vitest";

// Cloud's single-server lock (db/pool.js lockDatabase) against a scripted pg client: its own
// connection outside the pool, a session-level try-lock, closed when refused or released.
const fake = vi.hoisted(() => ({ locked: true, clients: [] }));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  class Client extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.queries = [];
      this.ended = false;
      fake.clients.push(this);
    }
    async connect() {}
    async query(text, params) {
      this.queries.push([text, params]);
      return { rows: [{ locked: fake.locked }] };
    }
    async end() {
      this.ended = true;
      this.emit("end"); // as pg does, also for a requested end()
    }
  }
  class Pool {
    on() {}
    async end() {}
  }
  return { default: { Client, Pool } };
});
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const { lockDatabase, SERVER_LOCK_KEY } = await import("../src/db/pool.js");
const { MIGRATION_LOCK_KEY } = await import("../src/db/migrate.js");

describe("lockDatabase (pg)", () => {
  beforeEach(() => {
    fake.locked = true;
    fake.clients = [];
  });

  it("holds a session advisory lock (not migrate.js's key) on its own connection until release", async () => {
    const onLost = vi.fn();
    const lock = await lockDatabase({ onLost });
    expect(lock).not.toBeNull();
    const [client] = fake.clients;
    expect(client.options).toMatchObject({
      connectionString: process.env.DATABASE_URL,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000
    });
    const [[text, params]] = client.queries;
    expect(text).toContain("pg_try_advisory_lock($1)");
    expect(SERVER_LOCK_KEY).toBe("1163547716");
    expect(params).toEqual([SERVER_LOCK_KEY]);
    expect(String(MIGRATION_LOCK_KEY)).not.toBe(SERVER_LOCK_KEY);
    expect(client.ended).toBe(false);
    await lock.release();
    expect(client.ended).toBe(true);
    expect(onLost).not.toHaveBeenCalled(); // its own end() is not a loss
  });

  it("returns null and closes the connection when another server holds the lock", async () => {
    fake.locked = false;
    const onLost = vi.fn();
    await expect(lockDatabase({ onLost })).resolves.toBeNull();
    expect(fake.clients[0].ended).toBe(true);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("reports the loss once when the lock connection errors or ends", async () => {
    const onLost = vi.fn();
    const lock = await lockDatabase({ onLost });
    const [client] = fake.clients;
    const err = new Error("Connection terminated unexpectedly");
    client.emit("error", err);
    client.emit("end");
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith(err);
    await lock.release(); // still closes the client

    const onLostToo = vi.fn();
    await lockDatabase({ onLost: onLostToo });
    fake.clients[1].emit("end");
    expect(onLostToo).toHaveBeenCalledWith(expect.any(Error));
  });
});

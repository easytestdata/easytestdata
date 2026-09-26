import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The pg migration path (DEPLOYMENT=cloud in vitest.config.js) against a scripted connection:
// advisory lock, one transaction per pending file with its _migrations row, unlock on failure.
const fake = vi.hoisted(() => ({ log: [], applied: [], failOn: null }));
vi.mock("../src/db/pool.js", () => {
  const client = {
    query: vi.fn(async (sql) => {
      const text = sql.trim();
      fake.log.push(text);
      if (fake.failOn && sql.includes(fake.failOn)) throw new Error("migration broke");
      if (text.startsWith("SELECT name FROM _migrations")) {
        return { rows: fake.applied.map((name) => ({ name })) };
      }
      return { rows: [], rowCount: 0 };
    })
  };
  return {
    withConnection: vi.fn(async (fn) => fn(client)),
    closeDatabase: vi.fn(async () => fake.log.push("closeDatabase")),
    execScript: vi.fn(),
    query: vi.fn()
  };
});
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const { runMigrations } = await import("../src/db/migrate.js");
const pool = await import("../src/db/pool.js");
const dir = new URL("../src/db/migrations/", import.meta.url);
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const lastSql = readFileSync(new URL(files.at(-1), dir), "utf8").trim();

describe("runMigrations on pg", () => {
  beforeEach(() => {
    fake.log = [];
    fake.applied = files.slice(0, -1);
    fake.failOn = null;
    vi.clearAllMocks();
  });

  it("applies each pending file with its bookkeeping row in one transaction, under the lock", async () => {
    await runMigrations();
    expect(fake.log[0]).toBe("SELECT pg_advisory_lock(1)");
    expect(fake.log.slice(-6)).toEqual([
      "BEGIN",
      lastSql, // the one pending file
      "INSERT INTO _migrations (name) VALUES ($1)",
      "COMMIT",
      "SELECT pg_advisory_unlock(1)",
      "closeDatabase"
    ]);
    expect(pool.execScript).not.toHaveBeenCalled();
  });

  it("rolls back a failing file, releases the lock and rethrows; closePool: false keeps the db", async () => {
    fake.failOn = "INSERT INTO _migrations";
    await expect(runMigrations({ closePool: false })).rejects.toThrow("migration broke");
    expect(fake.log.slice(-2)).toEqual(["ROLLBACK", "SELECT pg_advisory_unlock(1)"]);
    expect(fake.log).not.toContain("COMMIT");
    expect(pool.closeDatabase).not.toHaveBeenCalled();
  });

  it("refuses a database whose recorded migrations are not on disk, before applying anything", async () => {
    fake.applied = ["900_other.sql", "901_other.sql"];
    await expect(runMigrations({ closePool: false })).rejects.toThrow(
      /900_other\.sql, 901_other\.sql.*[Rr]ecreate the database/s
    );
    expect(fake.log).not.toContain("BEGIN");
    expect(fake.log.at(-1)).toBe("SELECT pg_advisory_unlock(1)");
  });

  it("does nothing but take and release the lock when every file is applied", async () => {
    fake.applied = files;
    await runMigrations({ closePool: false });
    expect(fake.log).not.toContain("BEGIN");
    expect(fake.log.at(-1)).toBe("SELECT pg_advisory_unlock(1)");
  });
});

describe("runMigrations on PGlite (scripted)", () => {
  it("rethrows the migration's own error even when ROLLBACK fails too", async () => {
    const { config } = await import("../src/config.js");
    const original = config.deployment;
    config.deployment = "local";
    try {
      pool.query.mockResolvedValue({ rows: files.slice(0, -1).map((name) => ({ name })) });
      pool.execScript.mockImplementation(async (sql) => {
        if (sql.startsWith("BEGIN;")) throw new Error("migration broke");
        if (sql === "ROLLBACK") throw new Error("no transaction in progress");
      });
      await expect(runMigrations({ closePool: false })).rejects.toThrow("migration broke");
      expect(pool.execScript).toHaveBeenLastCalledWith("ROLLBACK");
    } finally {
      config.deployment = original;
      pool.execScript.mockReset();
      pool.query.mockReset();
    }
  });
});

import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ order: [], sql: [], lockError: null, migrationError: null }));
const config = vi.hoisted(() => ({ deployment: "local", dataDir: "" }));
const lock = vi.hoisted(() => ({
  release: vi.fn(async () => calls.order.push("lock.release"))
}));
vi.mock("../src/config.js", () => ({ config }));
vi.mock("../src/local/instance-lock.js", () => ({
  lockDataDir: vi.fn(() => {
    calls.order.push("lock");
    if (calls.lockError) throw calls.lockError;
    return lock;
  })
}));
vi.mock("../src/db/pool.js", () => {
  const run = async (sql) => {
    calls.order.push("database");
    calls.sql.push(sql.trim());
    if (calls.migrationError) throw calls.migrationError;
    return { rows: [] };
  };
  return {
    execScript: vi.fn(run),
    query: vi.fn(run),
    withConnection: vi.fn(async (fn) => fn({ query: run })),
    closeDatabase: vi.fn(async () => calls.order.push("closeDatabase")),
    lockDatabase: vi.fn()
  };
});
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), fatal: vi.fn() }
}));

const root = fs.mkdtempSync(join(tmpdir(), "eztd-migrate-command-"));
const migrationsDir = join(root, "migrations");
fs.mkdirSync(migrationsDir);
fs.writeFileSync(join(migrationsDir, "001_extension.sql"), "SELECT 'extension migration';");
const pool = await import("../src/db/pool.js");
const { lockDataDir } = await import("../src/local/instance-lock.js");

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

describe("runMigrationCommand", () => {
  let command;

  beforeEach(async () => {
    calls.order = [];
    calls.sql = [];
    calls.lockError = null;
    calls.migrationError = null;
    config.deployment = "local";
    config.dataDir = join(fs.mkdtempSync(join(root, "command-")), "data");
    vi.clearAllMocks();
    command = await import("../src/db/migrate.js");
  });

  it("exports the command without running migrations or acquiring a lock on import", async () => {
    vi.resetModules();
    const imported = await import("../src/db/migrate.js");
    expect(imported.runMigrationCommand).toBeTypeOf("function");
    expect(calls.order).toEqual([]);
    expect(fs.existsSync(config.dataDir)).toBe(false);
  });

  it("creates a private local directory and locks it before database work, forwarding extensions", async () => {
    const mkdir = vi.spyOn(fs, "mkdirSync");
    lockDataDir.mockImplementationOnce((dir) => {
      expect(mkdir).toHaveBeenCalledWith(dir, { recursive: true, mode: 0o700 });
      expect(fs.existsSync(dir)).toBe(true);
      if (process.platform !== "win32") expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(calls.order).toEqual([]);
      calls.order.push("lock");
      return lock;
    });
    const onStart = vi.fn();
    await command.runMigrationCommand({
      extensions: [{ name: "demo-ext", migrationsDir, onStart }, { name: "hookless-ext" }]
    });
    expect(lockDataDir).toHaveBeenCalledExactlyOnceWith(config.dataDir);
    expect(calls.order[0]).toBe("lock");
    expect(calls.order.slice(-2)).toEqual(["closeDatabase", "lock.release"]);
    expect(calls.sql.some((sql) => sql.includes("_migrations_demo_ext"))).toBe(true);
    expect(calls.sql.some((sql) => sql.includes("SELECT 'extension migration';"))).toBe(true);
    expect(onStart).not.toHaveBeenCalled();
    expect(pool.withConnection).not.toHaveBeenCalled();
  });

  it("keeps the default command working without extensions", async () => {
    await command.runMigrationCommand();
    expect(calls.order[0]).toBe("lock");
    expect(calls.sql.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS _migrations"))).toBe(
      true
    );
    expect(calls.order.slice(-2)).toEqual(["closeDatabase", "lock.release"]);
  });

  it("propagates migration failure after closing the database and releasing the local lock", async () => {
    calls.migrationError = new Error("migration failed");
    await expect(command.runMigrationCommand()).rejects.toBe(calls.migrationError);
    expect(calls.order).toEqual(["lock", "database", "closeDatabase", "lock.release"]);
  });

  it("does no database work or lock release when the local lock is already held", async () => {
    calls.lockError = new Error("data directory is locked");
    await expect(command.runMigrationCommand()).rejects.toBe(calls.lockError);
    expect(calls.order).toEqual(["lock"]);
    expect(pool.execScript).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.withConnection).not.toHaveBeenCalled();
    expect(pool.closeDatabase).not.toHaveBeenCalled();
    expect(lock.release).not.toHaveBeenCalled();
  });

  it.each([
    [null, "Extensions must be an array"],
    [[{ name: "demo-ext", onStart: true }], "must be a function"]
  ])(
    "rejects invalid descriptors before filesystem or database work: %j",
    async (extensions, error) => {
      await expect(command.runMigrationCommand({ extensions })).rejects.toThrow(error);
      expect(calls.order).toEqual([]);
      expect(fs.existsSync(config.dataDir)).toBe(false);
    }
  );

  it("uses only the migration advisory lock in Cloud, without a local directory or server lock", async () => {
    config.deployment = "cloud";
    await command.runMigrationCommand({ extensions: [{ name: "demo-ext", migrationsDir }] });
    expect(lockDataDir).not.toHaveBeenCalled();
    expect(pool.lockDatabase).not.toHaveBeenCalled();
    expect(fs.existsSync(config.dataDir)).toBe(false);
    expect(pool.execScript).not.toHaveBeenCalled();
    expect(pool.withConnection).toHaveBeenCalledTimes(1);
    expect(calls.sql[0]).toBe("SELECT pg_advisory_lock(1)");
    expect(calls.sql.at(-1)).toBe("SELECT pg_advisory_unlock(1)");
    expect(calls.sql).toContain("SELECT 'extension migration';");
    expect(calls.order.at(-1)).toBe("closeDatabase");
    expect(lock.release).not.toHaveBeenCalled();
  });
});

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The pg migration path (DEPLOYMENT=cloud in vitest.config.js) against a scripted connection:
// advisory lock, one transaction per pending file with its _migrations row, unlock on failure.
const fake = vi.hoisted(() => ({
  log: [],
  applied: {},
  pending: null,
  failures: [],
  failure: new Error("migration broke")
}));
vi.mock("../src/db/pool.js", () => {
  const client = {
    query: vi.fn(async (sql, params) => {
      const text = sql.trim();
      fake.log.push(text);
      const failure = fake.failures.find(([fragment]) => text.includes(fragment));
      if (failure) throw failure[1];
      const select = text.match(/^SELECT name FROM (\w+) ORDER BY id$/);
      if (select) {
        return { rows: (fake.applied[select[1]] ?? []).map((name) => ({ name })) };
      }
      if (text === "BEGIN") {
        fake.pending = Object.fromEntries(
          Object.entries(fake.applied).map(([table, names]) => [table, [...names]])
        );
      }
      const insert = text.match(/^INSERT INTO (\w+) \(name\) VALUES \(\$1\)$/);
      if (insert) (fake.pending[insert[1]] ??= []).push(params[0]);
      if (text === "COMMIT") fake.applied = fake.pending;
      if (text === "COMMIT" || text === "ROLLBACK") fake.pending = null;
      return { rows: [], rowCount: 0 };
    })
  };
  return {
    withConnection: vi.fn(async (fn) => fn(client)),
    closeDatabase: vi.fn(async () => {
      fake.log.push("closeDatabase");
      const failure = fake.failures.find(([fragment]) => fragment === "closeDatabase");
      if (failure) throw failure[1];
    }),
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
const fixtureDir = mkdtempSync(join(tmpdir(), "eztd-migrate-pg-"));

function fixture(name, migrations) {
  const migrationsDir = mkdtempSync(join(fixtureDir, `${name}-`));
  for (const [file, sql] of Object.entries(migrations)) {
    writeFileSync(join(migrationsDir, file), sql);
  }
  return { name, migrationsDir };
}

afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

describe("runMigrations on pg", () => {
  beforeEach(() => {
    fake.log = [];
    fake.applied = { _migrations: files.slice(0, -1) };
    fake.pending = null;
    fake.failures = [];
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
    fake.failures = [["INSERT INTO _migrations", fake.failure]];
    await expect(runMigrations({ closePool: false })).rejects.toThrow("migration broke");
    expect(fake.log.slice(-2)).toEqual(["ROLLBACK", "SELECT pg_advisory_unlock(1)"]);
    expect(fake.log).not.toContain("COMMIT");
    expect(pool.closeDatabase).not.toHaveBeenCalled();
  });

  it("refuses a database whose recorded migrations are not on disk, before applying anything", async () => {
    fake.applied = { _migrations: ["900_other.sql", "901_other.sql"] };
    await expect(runMigrations({ closePool: false })).rejects.toThrow(
      /900_other\.sql, 901_other\.sql.*[Rr]ecreate the database/s
    );
    expect(fake.log).not.toContain("BEGIN");
    expect(fake.log.at(-1)).toBe("SELECT pg_advisory_unlock(1)");
  });

  it("does nothing but take and release the lock when every file is applied", async () => {
    fake.applied = { _migrations: files };
    await runMigrations({ closePool: false });
    expect(fake.log).not.toContain("BEGIN");
    expect(fake.log.at(-1)).toBe("SELECT pg_advisory_unlock(1)");
  });

  it("runs core first and extensions in supplied order under one lock and one connection", async () => {
    const first = fixture("demo-ext", {
      "002_next.sql": "SELECT 'demo second';",
      "001_widgets.sql": "SELECT 'demo first';"
    });
    const second = fixture("another-ext", { "001_next.sql": "SELECT 'another';" });
    await runMigrations({ extensions: [first, second] });
    expect(pool.withConnection).toHaveBeenCalledTimes(1);
    expect(fake.log.filter((sql) => sql === "SELECT pg_advisory_lock(1)")).toHaveLength(1);
    expect(fake.log.filter((sql) => sql === "SELECT pg_advisory_unlock(1)")).toHaveLength(1);
    const transactions = fake.log.filter(
      (sql) => ["BEGIN", "COMMIT", lastSql].includes(sql) || /^(SELECT '|INSERT INTO)/.test(sql)
    );
    expect(transactions).toEqual([
      "BEGIN",
      lastSql,
      "INSERT INTO _migrations (name) VALUES ($1)",
      "COMMIT",
      "BEGIN",
      "SELECT 'demo first';",
      "INSERT INTO _migrations_demo_ext (name) VALUES ($1)",
      "COMMIT",
      "BEGIN",
      "SELECT 'demo second';",
      "INSERT INTO _migrations_demo_ext (name) VALUES ($1)",
      "COMMIT",
      "BEGIN",
      "SELECT 'another';",
      "INSERT INTO _migrations_another_ext (name) VALUES ($1)",
      "COMMIT"
    ]);
    expect(fake.applied).toEqual({
      _migrations: files,
      _migrations_demo_ext: ["001_widgets.sql", "002_next.sql"],
      _migrations_another_ext: ["001_next.sql"]
    });
    fake.log = [];
    await runMigrations({ closePool: false, extensions: [first, second] });
    expect(fake.log).not.toContain("BEGIN");
  });

  it("does not read extension tracking tables in a core-only run", async () => {
    fake.applied = { _migrations: files, _migrations_demo_ext: ["900_private.sql"] };
    await runMigrations({ closePool: false });
    expect(fake.log.filter((sql) => sql.startsWith("SELECT name FROM"))).toEqual([
      "SELECT name FROM _migrations ORDER BY id"
    ]);
  });

  it("refuses unknown extension names in their own table, unlocks and closes", async () => {
    const extension = fixture("demo-ext", { "001_widgets.sql": "SELECT 1;" });
    fake.applied = { _migrations: files, _migrations_demo_ext: ["900_other.sql"] };
    await expect(runMigrations({ extensions: [extension] })).rejects.toThrow(/900_other\.sql/);
    expect(fake.log).not.toContain("BEGIN");
    expect(fake.log.slice(-2)).toEqual(["SELECT pg_advisory_unlock(1)", "closeDatabase"]);
    fake.applied._migrations_demo_ext = [];
    await runMigrations({ extensions: [extension] });
    expect(fake.applied._migrations_demo_ext).toEqual(["001_widgets.sql"]);
  });

  it.each(["SELECT 'extension';", "INSERT INTO _migrations_demo_ext"])(
    "rolls back extension failure at %s, then unlocks and closes",
    async (failure) => {
      const extension = fixture("demo-ext", { "001_widgets.sql": "SELECT 'extension';" });
      fake.failures = [[failure, fake.failure]];
      await expect(runMigrations({ extensions: [extension] })).rejects.toBe(fake.failure);
      expect(fake.applied._migrations).toEqual(files);
      expect(fake.applied._migrations_demo_ext).toBeUndefined();
      expect(fake.pending).toBeNull();
      expect(fake.log.slice(-3)).toEqual([
        "ROLLBACK",
        "SELECT pg_advisory_unlock(1)",
        "closeDatabase"
      ]);
      fake.failures = [];
      await runMigrations({ extensions: [extension] });
      expect(fake.applied._migrations_demo_ext).toEqual(["001_widgets.sql"]);
    }
  );

  it("preserves the migration error when rollback, unlock and close also fail", async () => {
    fake.failures = [
      ["INSERT INTO _migrations", fake.failure],
      ["ROLLBACK", new Error("rollback failed")],
      ["pg_advisory_unlock", new Error("unlock failed")],
      ["closeDatabase", new Error("close failed")]
    ];
    await expect(runMigrations()).rejects.toBe(fake.failure);
    expect(fake.log.slice(-3)).toEqual([
      "ROLLBACK",
      "SELECT pg_advisory_unlock(1)",
      "closeDatabase"
    ]);
  });

  it.each(["pg_advisory_lock", "pg_advisory_unlock", "closeDatabase"])(
    "reports a standalone %s failure and closes when requested",
    async (failure) => {
      fake.failures = [[failure, fake.failure]];
      await expect(runMigrations()).rejects.toBe(fake.failure);
      expect(pool.closeDatabase).toHaveBeenCalledOnce();
      fake.failures = [];
      await runMigrations();
    }
  );

  it.each([
    ["invalid name", () => [{ name: "bad_name" }], /name/i],
    ["duplicate name", () => [{ name: "demo-ext" }, { name: "demo-ext" }], /duplicate/i],
    [
      "missing directory",
      () => [{ name: "demo-ext", migrationsDir: join(fixtureDir, "missing") }],
      /ENOENT/
    ],
    ["invalid filename", () => [fixture("demo-ext", { "001_Widgets.sql": "SELECT 1;" })], /name/i],
    [
      "duplicate prefix",
      () => [fixture("demo-ext", { "001_one.sql": "SELECT 1;", "001_two.sql": "SELECT 2;" })],
      /duplicate/i
    ],
    [
      "gap",
      () => [fixture("demo-ext", { "001_one.sql": "SELECT 1;", "003_two.sql": "SELECT 2;" })],
      /sequence|gap|contiguous/i
    ]
  ])("rejects %s before database work", async (_label, extensions, error) => {
    await expect(runMigrations({ extensions: extensions() })).rejects.toThrow(error);
    expect(pool.withConnection).not.toHaveBeenCalled();
    expect(fake.log).toEqual(["closeDatabase"]);
    await runMigrations({ extensions: [fixture("demo-ext", { "001_valid.sql": "SELECT 1;" })] });
    expect(fake.applied._migrations_demo_ext).toEqual(["001_valid.sql"]);
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

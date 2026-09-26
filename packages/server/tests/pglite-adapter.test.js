import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "eztd-pglite-"));
// Not created yet: opening the database creates it (as `pnpm run migrate` does on a first run).
const dataDir = join(dir, "data");
vi.stubEnv("DEPLOYMENT", "local");
vi.stubEnv("DATABASE_URL", "postgres://should-be-ignored-in-local-mode");
vi.stubEnv("EASYTESTDATA_DATA_DIR", dataDir);
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

const db = await import("../src/db/pool.js");
const { runMigrations } = await import("../src/db/migrate.js");

describe("PGlite adapter", () => {
  beforeAll(async () => runMigrations({ closePool: false }), 60_000);
  afterAll(async () => {
    await db.closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the data dir and its database dir private (0700) before the database opens", () => {
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, "db")).mode & 0o777).toBe(0o700);
  });

  it("applies migrations once and reports rowCount like pg", async () => {
    await runMigrations({ closePool: false }); // second run: no-op
    const { rows } = await db.query("SELECT name FROM _migrations ORDER BY id");
    expect(rows).toEqual([{ name: "001_initial_schema.sql" }]);
    expect((await db.query("UPDATE users SET email = email WHERE false")).rowCount).toBe(0);
    // PGlite reports affectedRows = 0 for a SELECT; pg reports the rows returned.
    expect((await db.query("SELECT * FROM generate_series(1, 3)")).rowCount).toBe(3);
  });

  it("refuses a database that records a migration this version does not have", async () => {
    await db.query("INSERT INTO _migrations (name) VALUES ('900_other.sql')");
    try {
      await expect(runMigrations({ closePool: false })).rejects.toThrow(
        /900_other\.sql.*[Rr]ecreate the database/s
      );
    } finally {
      await db.query("DELETE FROM _migrations WHERE name = '900_other.sql'");
    }
  });

  it("commits what fn wrote, and rolls back and rethrows when fn throws", async () => {
    const value = await db.transaction(async (client) => {
      await client.query("INSERT INTO teams (name) VALUES ('committed')");
      return "done";
    });
    expect(value).toBe("done");
    await expect(
      db.transaction(async (client) => {
        await client.query("INSERT INTO teams (name) VALUES ('thrown')");
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    const { rows } = await db.query(
      "SELECT name FROM teams WHERE name IN ('committed', 'thrown') ORDER BY name"
    );
    expect(rows).toEqual([{ name: "committed" }]);
    expect((await db.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]); // not left in a tx
  });

  it("rolls back with rollback(), and refuses misuse loudly instead of deadlocking", async () => {
    let leaked;
    await db.transaction(async (client) => {
      leaked = client;
      await client.query("INSERT INTO teams (name) VALUES ('tx-team')");
      const seen = await client.query(
        "SELECT COUNT(*)::int AS n FROM teams WHERE name = 'tx-team'"
      );
      expect(seen.rows[0].n).toBe(1);
      await expect(db.query("SELECT 1")).rejects.toThrow(/use the transaction's client/);
      await expect(db.transaction(async () => {})).rejects.toThrow(/Nested/);
      // The single connection is held by this transaction: these would wait for it forever.
      await expect(db.execScript("SELECT 1")).rejects.toThrow(/inside transaction/);
      await expect(db.withConnection(async () => {})).rejects.toThrow(/inside transaction/);
      return db.rollback(null);
    });
    expect(() => leaked.query("SELECT 1")).toThrow(/after its transaction ended/);
    const after = await db.query("SELECT COUNT(*)::int AS n FROM teams WHERE name = 'tx-team'");
    expect(after.rows[0].n).toBe(0);
  });

  it("makes a concurrent request wait instead of joining or deadlocking", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const order = [];
    const tx = db.transaction(async (client) => {
      await client.query("INSERT INTO teams (name) VALUES ('iso')");
      order.push("tx-insert");
      await gate;
      return db.rollback(null);
    });
    await new Promise((r) => setTimeout(r, 10));
    const other = db.query("SELECT COUNT(*)::int AS n FROM teams WHERE name = 'iso'").then((r) => {
      order.push(`other-saw-${r.rows[0].n}`);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["tx-insert"]); // other is waiting
    release();
    await Promise.all([tx, other]);
    expect(order).toEqual(["tx-insert", "other-saw-0"]); // never saw the rolled-back row
  });
});

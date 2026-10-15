import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "eztd-extension-migrations-"));
vi.stubEnv("DEPLOYMENT", "local");
vi.stubEnv("EASYTESTDATA_DATA_DIR", join(dir, "data"));
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

const db = await import("../src/db/pool.js");
const { runMigrations } = await import("../src/db/migrate.js");
const { logger } = await import("../src/logger.js");

function fixture(name, files = { "001_widgets.sql": "CREATE TABLE widgets (id INTEGER);" }) {
  const migrationsDir = mkdtempSync(join(dir, `${name}-`));
  for (const [file, sql] of Object.entries(files)) writeFileSync(join(migrationsDir, file), sql);
  return { name, migrationsDir };
}

async function migrate(extensions = []) {
  await runMigrations({ closePool: false, extensions });
}

async function tables() {
  const { rows } = await db.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
  );
  return rows.map((row) => row.tablename);
}

describe("extension migrations on PGlite", () => {
  beforeEach(async () => {
    await db.execScript("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    vi.clearAllMocks();
  }, 60_000);

  afterAll(async () => {
    await db.closeDatabase();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("applies core then ordered extension sets separately, reruns once and ignores them in core-only mode", async () => {
    const extension = fixture("demo-ext", {
      "001_widgets.sql": "CREATE TABLE widgets (team_id UUID REFERENCES teams(id), label TEXT);"
    });
    const second = fixture("second-ext", {
      "001_more.sql": "ALTER TABLE widgets ADD COLUMN extra TEXT;"
    });
    await migrate([extension, second, { name: "routes-only" }]);
    await db.query("INSERT INTO widgets (label, extra) VALUES ('kept', 'also kept')");
    await migrate([extension, second]);
    expect((await db.query("SELECT name FROM _migrations ORDER BY id")).rows).toEqual([
      { name: "001_initial_schema.sql" }
    ]);
    expect((await db.query("SELECT name FROM _migrations_demo_ext ORDER BY id")).rows).toEqual([
      { name: "001_widgets.sql" }
    ]);
    expect((await db.query("SELECT name FROM _migrations_second_ext ORDER BY id")).rows).toEqual([
      { name: "001_more.sql" }
    ]);
    expect(await tables()).not.toContain("_migrations_routes_only");
    // A public-only build must ignore even unknown extension names and absent extension files.
    await db.query("INSERT INTO _migrations_demo_ext (name) VALUES ('900_private.sql')");
    rmSync(extension.migrationsDir, { recursive: true });
    await migrate();
    expect((await db.query("SELECT label, extra FROM widgets")).rows).toEqual([
      { label: "kept", extra: "also kept" }
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      { table: "_migrations", count: 1 },
      "Applied 1 migration(s)"
    );
    expect(logger.info).toHaveBeenCalledWith(
      { table: "_migrations_demo_ext", count: 0 },
      "No new migrations"
    );
  });

  it.each(["_migrations", "_migrations_demo_ext"])(
    "refuses unknown recorded names only in the selected set %s",
    async (table) => {
      const extension = fixture("demo-ext");
      await migrate([extension]);
      await db.query(`INSERT INTO ${table} (name) VALUES ('900_other.sql')`);
      await expect(migrate([extension])).rejects.toThrow(
        /900_other\.sql.*[Rr]ecreate the database/s
      );
      await db.query(`DELETE FROM ${table} WHERE name = '900_other.sql'`);
      await migrate([extension]);
    }
  );

  it.each([
    ["invalid descriptor", [{ name: "bad_name" }], /name/i],
    ["duplicate descriptor", [{ name: "demo-ext" }, { name: "demo-ext" }], /duplicate/i],
    ["missing directory", [{ name: "demo-ext", migrationsDir: join(dir, "missing") }], /ENOENT/]
  ])("rejects %s before even core DDL", async (_label, extensions, error) => {
    await expect(migrate(extensions)).rejects.toThrow(error);
    expect(await tables()).toEqual([]);
    await migrate([{ name: "demo-ext" }]);
    expect(await tables()).toContain("users");
  });

  it.each([
    ["invalid filename", ["001_Widgets.sql"], /name/i],
    ["duplicate prefix", ["001_widgets.sql", "001_other.sql"], /duplicate/i],
    ["sequence gap", ["001_widgets.sql", "003_other.sql"], /sequence|gap|contiguous/i]
  ])("rejects %s in a later set before any DDL", async (_label, files, error) => {
    const first = fixture("first-ext");
    const bad = fixture("demo-ext", Object.fromEntries(files.map((file) => [file, "SELECT 1;"])));
    await expect(migrate([first, bad])).rejects.toThrow(error);
    expect(await tables()).toEqual([]);
    rmSync(bad.migrationsDir, { recursive: true });
    await migrate([first, fixture("demo-ext", { "001_valid.sql": "SELECT 1;" })]);
    expect(await tables()).toContain("widgets");
  });

  it("reads every file before DDL, even an already recorded file", async () => {
    const extension = fixture("demo-ext");
    mkdirSync(join(extension.migrationsDir, "002_unreadable.sql"));
    await expect(migrate([extension])).rejects.toThrow(/EISDIR/);
    expect(await tables()).toEqual([]);
    rmSync(join(extension.migrationsDir, "002_unreadable.sql"), { recursive: true });
    await migrate([extension]);
    rmSync(join(extension.migrationsDir, "001_widgets.sql"));
    mkdirSync(join(extension.migrationsDir, "001_widgets.sql"));
    await expect(migrate([extension])).rejects.toThrow(/EISDIR/);
    expect((await db.query("SELECT count(*)::int AS n FROM _migrations_demo_ext")).rows).toEqual([
      { n: 1 }
    ]);
  });

  it("rolls back a failed extension's schema and row, then applies the corrected file", async () => {
    const extension = fixture("demo-ext", {
      "001_widgets.sql": "CREATE TABLE widgets (id INTEGER); SELECT * FROM missing_table;"
    });
    await expect(migrate([extension])).rejects.toThrow(/missing_table/);
    expect(await tables()).toContain("users");
    expect(await tables()).not.toContain("widgets");
    expect((await db.query("SELECT name FROM _migrations_demo_ext")).rows).toEqual([]);
    writeFileSync(
      join(extension.migrationsDir, "001_widgets.sql"),
      "CREATE TABLE widgets (id INTEGER);"
    );
    await migrate([extension]);
    expect(await tables()).toContain("widgets");
    expect((await db.query("SELECT name FROM _migrations_demo_ext")).rows).toEqual([
      { name: "001_widgets.sql" }
    ]);
  });

  it("rolls back extension DDL when its tracking INSERT fails", async () => {
    const extension = fixture("demo-ext", {
      "001_widgets.sql": "CREATE TABLE widgets (id INTEGER); DROP TABLE _migrations_demo_ext;"
    });
    await expect(migrate([extension])).rejects.toThrow(/_migrations_demo_ext/);
    expect(await tables()).not.toContain("widgets");
    expect((await db.query("SELECT name FROM _migrations_demo_ext")).rows).toEqual([]);
    writeFileSync(
      join(extension.migrationsDir, "001_widgets.sql"),
      "CREATE TABLE widgets (id INTEGER);"
    );
    await migrate([extension]);
    expect(await tables()).toContain("widgets");
  });
});

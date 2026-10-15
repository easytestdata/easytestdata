import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { config } from "../config.js";
import { migrationTableName, validateExtensions } from "../extensions.js";
import { closeDatabase, execScript, query, withConnection } from "./pool.js";
import { logger } from "../logger.js";
import { lockDataDir } from "../local/instance-lock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");
/** pg advisory lock key serializing migration runs (the running server holds another key). */
export const MIGRATION_LOCK_KEY = 1;

function trackingTableSql(table) {
  return `
  CREATE TABLE IF NOT EXISTS ${table} (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ DEFAULT NOW()
  )
`;
}
// Migration file names are written into SQL on the PGlite path, so only this shape is accepted.
const MIGRATION_NAME = /^\d{3}_[a-z0-9_]+\.sql$/;

/** The migration files in apply order; a .sql file with an unexpected name is refused. */
function migrationFiles(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const bad = files.find((f) => !MIGRATION_NAME.test(f));
  if (bad) throw new Error(`Migration file name ${bad} does not match ${MIGRATION_NAME}`);
  for (let i = 1; i < files.length; i++) {
    const previous = Number(files[i - 1].slice(0, 3));
    const current = Number(files[i].slice(0, 3));
    if (current === previous) {
      throw new Error(`Duplicate migration prefix in ${dir}: ${files[i - 1]}, ${files[i]}`);
    }
    if (current !== previous + 1) {
      throw new Error(`Non-contiguous migration sequence in ${dir}: ${files[i - 1]}, ${files[i]}`);
    }
  }
  return files;
}

/**
 * The names recorded in a selected tracking table. A name with no file on disk means another version of
 * EasyTestData built the database; applying these files on top of it would mis-migrate, so it is
 * refused.
 */
async function appliedMigrations(db, files, table) {
  const { rows } = await db.query(`SELECT name FROM ${table} ORDER BY id`);
  const applied = new Set(rows.map((r) => r.name));
  const unknown = [...applied].filter((name) => !files.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `Database records migrations this version does not have (${unknown.join(", ")}): another ` +
        "version built it. Recreate the database (drop it, or delete the local data directory) " +
        "and start again."
    );
  }
  return applied;
}

function readMigration(dir, file) {
  return fs.readFileSync(path.join(dir, file), "utf8");
}

/**
 * pg: one dedicated connection holding an advisory lock (several server processes may start at
 * once), each file applied with its _migrations row in one transaction, so a failure never
 * leaves a half-applied schema behind.
 */
async function migratePg(sets) {
  return withConnection(async (client) => {
    await client.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
    let failed = false;
    try {
      for (const { table, files, migrations } of sets) {
        await client.query(trackingTableSql(table));
        const applied = await appliedMigrations(client, files, table);
        let count = 0;
        for (const file of files) {
          if (applied.has(file)) continue;
          logger.info({ migration: file }, "Applying migration");
          await client.query("BEGIN");
          try {
            await client.query(migrations.get(file));
            await client.query(`INSERT INTO ${table} (name) VALUES ($1)`, [file]);
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
          }
          count++;
        }
        logger.info(
          { table, count },
          count === 0 ? "No new migrations" : `Applied ${count} migration(s)`
        );
      }
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      const unlock = client.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
      if (failed) await unlock.catch(() => {});
      else await unlock;
    }
  });
}

/**
 * PGlite: one process owns the database, so no lock. Each file and its _migrations row run as one
 * multi-statement script inside BEGIN/COMMIT.
 */
async function migrateEmbedded(sets) {
  for (const { table, files, migrations } of sets) {
    await execScript(trackingTableSql(table));
    const applied = await appliedMigrations({ query }, files, table);
    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      logger.info({ migration: file }, "Applying migration");
      const sql = migrations.get(file);
      try {
        await execScript(
          `BEGIN;\n${sql}\n;INSERT INTO ${table} (name) VALUES ('${file}');\nCOMMIT;`
        );
      } catch (err) {
        // Keep the migration's own error even if ROLLBACK fails too.
        await execScript("ROLLBACK").catch(() => {});
        throw err;
      }
      count++;
    }
    logger.info(
      { table, count },
      count === 0 ? "No new migrations" : `Applied ${count} migration(s)`
    );
  }
}

export async function runMigrations({ closePool = true, extensions = [] } = {}) {
  let failed = false;
  try {
    validateExtensions(extensions);
    // Prepare every set before any DDL. Only core's constant and validated extension names
    // produce table identifiers; file names are also validated before PGlite interpolates them.
    const sets = [
      { dir: MIGRATIONS_DIR, table: "_migrations" },
      ...extensions
        .filter((extension) => extension.migrationsDir !== undefined)
        .map((extension) => ({
          dir: extension.migrationsDir,
          table: migrationTableName(extension.name)
        }))
    ].map(({ dir, table }) => {
      const files = migrationFiles(dir);
      const migrations = new Map(files.map((file) => [file, readMigration(dir, file)]));
      return { table, files, migrations };
    });
    if (config.deployment === "local") await migrateEmbedded(sets);
    else await migratePg(sets);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (closePool) {
      if (failed) await closeDatabase().catch(() => {});
      else await closeDatabase();
    }
  }
}

/**
 * Local mode takes the data dir's server lock first, so it never opens PGlite
 * while the app (or another migrate) has it open.
 */
export async function runMigrationCommand({ extensions = [] } = {}) {
  validateExtensions(extensions);
  let lock = null;
  try {
    if (config.deployment === "local") {
      fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
      lock = lockDataDir(config.dataDir);
    }
    await runMigrations({ extensions });
  } finally {
    await lock?.release();
  }
}

async function main() {
  try {
    await runMigrationCommand();
  } catch (err) {
    logger.fatal({ err }, "Migration failed");
    process.exit(1);
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entryUrl && import.meta.url === entryUrl) {
  main();
}

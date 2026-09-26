import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { config } from "../config.js";
import { closeDatabase, execScript, query, withConnection } from "./pool.js";
import { logger } from "../logger.js";
import { lockDataDir } from "../local/instance-lock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");
/** pg advisory lock key serializing migration runs (the running server holds another key). */
export const MIGRATION_LOCK_KEY = 1;

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS _migrations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ DEFAULT NOW()
  )
`;
// Migration file names are written into SQL on the PGlite path, so only this shape is accepted.
const MIGRATION_NAME = /^\d{3}_[a-z0-9_]+\.sql$/;

/** The migration files in apply order; a .sql file with an unexpected name is refused. */
function migrationFiles() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const bad = files.find((f) => !MIGRATION_NAME.test(f));
  if (bad) throw new Error(`Migration file name ${bad} does not match ${MIGRATION_NAME}`);
  return files;
}

/**
 * The names recorded in _migrations. A name with no file on disk means another version of
 * EasyTestData built the database; applying these files on top of it would mis-migrate, so it is
 * refused.
 */
async function appliedMigrations(db, files) {
  const { rows } = await db.query("SELECT name FROM _migrations ORDER BY id");
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

function readMigration(file) {
  logger.info({ migration: file }, "Applying migration");
  return fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
}

/**
 * pg: one dedicated connection holding an advisory lock (several server processes may start at
 * once), each file applied with its _migrations row in one transaction, so a failure never
 * leaves a half-applied schema behind.
 */
async function migratePg() {
  return withConnection(async (client) => {
    await client.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
    try {
      await client.query(MIGRATIONS_TABLE);
      const files = migrationFiles();
      const applied = await appliedMigrations(client, files);
      let count = 0;
      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = readMigration(file);
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
        count++;
      }
      return count;
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
    }
  });
}

/**
 * PGlite: one process owns the database, so no lock. Each file and its _migrations row run as one
 * multi-statement script inside BEGIN/COMMIT.
 */
async function migrateEmbedded() {
  await execScript(MIGRATIONS_TABLE);
  const files = migrationFiles();
  const applied = await appliedMigrations({ query }, files);
  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readMigration(file);
    try {
      await execScript(
        `BEGIN;\n${sql}\n;INSERT INTO _migrations (name) VALUES ('${file}');\nCOMMIT;`
      );
    } catch (err) {
      // Keep the migration's own error even if ROLLBACK fails too.
      await execScript("ROLLBACK").catch(() => {});
      throw err;
    }
    count++;
  }
  return count;
}

export async function runMigrations(options = {}) {
  const closePool = options.closePool !== false;
  try {
    const count = config.deployment === "local" ? await migrateEmbedded() : await migratePg();
    logger.info({ count }, count === 0 ? "No new migrations" : `Applied ${count} migration(s)`);
  } finally {
    if (closePool) await closeDatabase();
  }
}

/**
 * `pnpm run migrate`. Local mode takes the data dir's server lock first, so it never opens PGlite
 * while the app (or another migrate) has it open.
 */
async function main() {
  let lock = null;
  let failed = false;
  try {
    if (config.deployment === "local") {
      fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
      lock = lockDataDir(config.dataDir);
    }
    await runMigrations();
  } catch (err) {
    logger.fatal({ err }, "Migration failed");
    failed = true;
  } finally {
    await lock?.release();
  }
  if (failed) process.exit(1);
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entryUrl && import.meta.url === entryUrl) {
  main();
}

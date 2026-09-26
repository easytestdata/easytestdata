import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { config } from "../config.js";
import { logger } from "../logger.js";

// The transaction scope of the code currently running inside transaction(fn), if any. Used only
// to catch mistakes: inside a transaction, code must use the client it was given.
const scope = new AsyncLocalStorage();
const ROLLBACK = Symbol("rollback");
// Session advisory lock key held by a running server ("EZTD" in ASCII); migrate.js has its own.
export const SERVER_LOCK_KEY = "1163547716";
/** Return rollback(value) from a transaction's fn to roll it back and still resolve to `value`. */
export const rollback = (value) => ({ [ROLLBACK]: true, value });

// Local mode always uses the embedded database, even if DATABASE_URL is set in the environment.
const backend =
  config.deployment === "local"
    ? createEmbedded(join(config.dataDir, "db"))
    : createPg(config.database.url);

function createPg(url) {
  if (!url) throw new Error("DATABASE_URL is required when DEPLOYMENT=cloud");
  const pool = new pg.Pool({
    connectionString: url,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });
  pool.on("error", (err) => logger.error({ err }, "Unexpected database pool error"));
  return {
    query: (text, params) => pool.query(text, params),
    async withConnection(fn) {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    },
    execScript: (sql) => pool.query(sql),
    close: () => pool.end(),
    async lockServer({ onLost }) {
      // Its own connection, outside the pool, for the whole process: the session lock lasts
      // exactly as long as the connection, so losing the connection loses the lock.
      const client = new pg.Client({
        connectionString: url,
        connectionTimeoutMillis: 5_000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10_000
      });
      let held = false;
      let released = false; // by release(): its own end() is not a loss
      let reported = false;
      const lost = (err) => {
        if (!held || released || reported) return;
        reported = true;
        onLost(err ?? new Error("The server lock connection closed"));
      };
      client.on("error", (err) => {
        logger.error({ err }, "Server lock connection error");
        lost(err);
      });
      client.on("end", () => lost());
      await client.connect();
      try {
        const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [
          SERVER_LOCK_KEY
        ]);
        held = rows[0]?.locked === true;
      } catch (err) {
        await client.end().catch(() => {});
        throw err;
      }
      if (!held) {
        await client.end();
        return null;
      }
      return {
        release: async () => {
          if (released) return;
          released = true;
          await client.end().catch(() => {}); // after a loss the connection may already be gone
        }
      };
    }
  };
}

function createEmbedded(dbDir) {
  let opened;
  // The data dir holds the database and secret.key: create it (and dbDir) private before PGlite
  // opens it, also when `pnpm run migrate` runs before the first `easytestdata ui`. PGlite itself
  // does not create missing parent directories.
  const open = async () => {
    mkdirSync(dbDir, { recursive: true, mode: 0o700 });
    const { PGlite } = await import("@electric-sql/pglite");
    return PGlite.create(dbDir);
  };
  const db = () => (opened ??= open());
  let tail = Promise.resolve();
  // One connection: callers take turns; a transaction holds the turn until it ends.
  const turn = (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => {},
      () => {}
    );
    return run;
  };
  // affectedRows is 0 (not undefined) for a SELECT, where pg reports the rows returned.
  const normalize = (r) => ({ rows: r.rows, rowCount: r.affectedRows || r.rows.length });
  const raw = { query: async (text, params) => normalize(await (await db()).query(text, params)) };
  return {
    query: (text, params) => turn(() => raw.query(text, params)),
    withConnection: (fn) => turn(() => fn(raw)),
    execScript: (sql) => turn(async () => (await db()).exec(sql)),
    close: async () => opened && (await (await opened).close())
  };
}

/** Refuses module-level database use inside transaction(fn); on PGlite it would wait forever. */
function assertOutsideTransaction(name) {
  if (scope.getStore()?.active) {
    throw new Error(`${name}() called inside transaction(): use the transaction's client`);
  }
}

export async function query(text, params) {
  assertOutsideTransaction("query");
  return backend.query(text, params);
}

/**
 * Runs fn(client) in one transaction: BEGIN, fn, COMMIT; ROLLBACK and rethrow if fn throws.
 * Return rollback(value) from fn to roll back and still return `value` (e.g. an early 4xx).
 * Inside fn, use only the client it receives; module-level query() throws there.
 */
export async function transaction(fn) {
  if (scope.getStore()?.active) throw new Error("Nested transaction() is not supported");
  return backend.withConnection(async (conn) => {
    const state = { active: true };
    // The client handed to fn refuses use after the transaction ends (e.g. a stray timer).
    const client = {
      query(text, params) {
        if (!state.active) throw new Error("Transaction client used after its transaction ended");
        return conn.query(text, params);
      }
    };
    await conn.query("BEGIN");
    try {
      let result;
      try {
        result = await scope.run(state, () => fn(client));
      } finally {
        state.active = false; // before COMMIT/ROLLBACK: a retained client can't slip in a write
      }
      if (result && result[ROLLBACK]) {
        await conn.query("ROLLBACK");
        return result.value;
      }
      await conn.query("COMMIT");
      return result;
    } catch (err) {
      await conn.query("ROLLBACK").catch(() => {});
      throw err;
    }
  });
}

/** Multi-statement SQL (migrations). Throws inside transaction(). */
export async function execScript(sql) {
  assertOutsideTransaction("execScript");
  return backend.execScript(sql);
}
export const closeDatabase = () => backend.close();
/**
 * Cloud (pg): takes the single-server advisory lock on a dedicated connection. Resolves
 * { release() } (closes that connection), or null when another server already holds it.
 * onLost(err) runs once if the connection fails or closes before release(): the lock is gone.
 */
export async function lockDatabase({ onLost }) {
  if (!backend.lockServer) throw new Error("lockDatabase() is for the pg backend only");
  return backend.lockServer({ onLost });
}
/** A raw connection for the duration of fn; migrate.js (pg path) only. Throws inside transaction(). */
export async function withConnection(fn) {
  assertOutsideTransaction("withConnection");
  return backend.withConnection(fn);
}

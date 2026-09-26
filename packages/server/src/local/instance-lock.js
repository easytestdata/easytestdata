import { randomBytes } from "node:crypto";
import { linkSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_FILE = "server.lock";
// Held (for microseconds) by the one starter replacing a stale lock; see takeOver.
const TAKEOVER_SUFFIX = ".takeover";
// A lock file without a readable pid (hand-made, or damaged) counts as held until it is this old.
const UNREADABLE_GRACE_MS = 10_000;

/** { pid, ageMs } for the lock file (pid null when unreadable), or null when it is missing. */
function inspect(file) {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    const ageMs = Date.now() - statSync(file).mtimeMs;
    return { pid: Number.isInteger(pid) && pid > 0 ? pid : null, ageMs };
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists, owned by another user
  }
}

/**
 * Creates the lock file atomically: the pid goes to a private temp file, which is then hard-linked
 * into place. link() fails if the lock exists, so the file is never seen half-written and two
 * starters can never both create it. Returns false when it exists.
 */
function tryCreate(file) {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  try {
    linkSync(temp, file);
    return true;
  } catch (err) {
    if (err.code === "EEXIST") return false;
    throw err;
  } finally {
    unlinkSync(temp);
  }
}

/** Whether a lock file inspected as `held` still belongs to a running (or starting) process. */
function isHeld(held) {
  if (!held) return false;
  if (held.pid) return isAlive(held.pid);
  return held.ageMs < UNREADABLE_GRACE_MS;
}

/**
 * Replaces a stale lock with ours. Only one starter at a time may take over: it first creates the
 * takeover guard `<lock>.takeover` (the same atomic link() create as the lock). While the guard
 * exists nobody else replaces or removes the lock file (a live owner only removes its own pid, a
 * stale owner is gone, other starters need the guard), so the re-check below and the removal see
 * the same file, and the lock path is never shown empty to a starter whose live lock was moved.
 * A starter that finds the guard taken refuses: another one is starting on this data folder.
 * The guard is removed before returning (or throwing).
 */
function takeOver(file, hooks) {
  const guard = `${file}${TAKEOVER_SUFFIX}`;
  if (!tryCreate(guard)) {
    // Either another starter is replacing the stale lock right now, or a starter died between
    // creating the guard and removing it (a crash inside this function) and left it behind. A
    // guard whose pid is alive can still be a leftover (the pid reused by an unrelated process),
    // so every refusal names the file and says when to delete it.
    const other = inspect(guard);
    const leftover =
      `earlier start was interrupted and left ${guard}. If EasyTestData is not running, ` +
      "delete that file and try again.";
    if (other?.pid && isAlive(other.pid)) {
      throw new Error(
        `Another copy of EasyTestData may be starting with this data folder (pid ${other.pid}). ` +
          `Or an ${leftover}`
      );
    }
    throw new Error(`An ${leftover}`);
  }
  try {
    hooks.holdingGuard?.();
    const current = inspect(file);
    if (isHeld(current)) throw alreadyRunning(current.pid ? `pid ${current.pid}` : `see ${file}`);
    if (current) {
      try {
        unlinkSync(file);
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    }
    if (!tryCreate(file)) throw alreadyRunning(`${file} was just created by another process`);
  } finally {
    unlinkSync(guard);
  }
}

function alreadyRunning(detail) {
  return new Error(
    `EasyTestData is already running with this data folder (${detail}). Stop it first, or use ` +
      "--data-dir for a separate copy."
  );
}

/**
 * Local mode: one process per data dir (PGlite must never be opened by two processes): the server
 * and a directly run `migrate`. Creates `<dataDir>/server.lock` holding this pid; a lock whose
 * process is gone is taken over by one starter at a time (see takeOver). Throws when a live
 * process holds it. Returns { release() }, which removes the file (also run at process exit, e.g.
 * a second Ctrl+C that exits without waiting). `hooks` (beforeClaim: a stale lock was seen;
 * holdingGuard: inside the takeover) exist for the race tests.
 *
 * Accepted residual: a starter killed inside takeOver (between creating and removing the guard,
 * a few file operations) leaves `server.lock.takeover` behind; later starts that find a stale lock
 * then refuse and name the file to delete. Nothing is ever run twice on one data folder.
 */
export function lockDataDir(dataDir, { hooks = {} } = {}) {
  const file = join(dataDir, LOCK_FILE);
  if (!tryCreate(file)) {
    const held = inspect(file);
    if (isHeld(held)) throw alreadyRunning(held.pid ? `pid ${held.pid}` : `see ${file}`);
    if (held) {
      // Stale: its process has exited without removing it (or it has been unreadable for long).
      hooks.beforeClaim?.();
      takeOver(file, hooks);
    } else if (!tryCreate(file)) {
      // It vanished between the create and the inspection; one more create decides.
      throw alreadyRunning(`${file} was just created by another process`);
    }
  }

  const release = () => {
    process.off("exit", release);
    if (inspect(file)?.pid !== process.pid) return; // never remove another process's lock
    try {
      unlinkSync(file);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  };
  process.on("exit", release);
  return { release: async () => release() };
}

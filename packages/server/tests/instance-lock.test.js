import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lockDataDir } from "../src/local/instance-lock.js";

// Two starters racing to take over a stale lock: exactly one may win. The race is replayed
// deterministically through lockDataDir's hooks, which run the other starter at the exact moment
// between inspecting the stale lock and claiming it.

const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;

let dir;
let file;
const held = [];

function lockOrError(hooks) {
  try {
    const lock = lockDataDir(dir, { hooks });
    held.push(lock);
    return lock;
  } catch (err) {
    return err;
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eztd-instance-lock-"));
  file = join(dir, "server.lock");
  writeFileSync(file, `${deadPid}\n`, { mode: 0o600 });
});

afterEach(async () => {
  while (held.length) await held.pop().release();
  rmSync(dir, { recursive: true, force: true });
});

describe("stale lock takeover", () => {
  it("lets exactly one of two starters win when the other takes over in between", () => {
    let second;
    const first = lockOrError({
      // The first starter has seen the stale lock; the second one now runs to completion.
      beforeClaim: () => {
        second = lockOrError();
      }
    });

    expect(second).not.toBeInstanceOf(Error);
    expect(first).toBeInstanceOf(Error);
    expect(first.message).toMatch(/already running/);
    // The winner's lock file is still in place, and no side file is left behind.
    expect(statSync(file).isFile()).toBe(true);
    expect(readdirSync(dir)).toEqual(["server.lock"]);
  });

  it("refuses a starter that arrives while another is taking over, and the takeover completes", () => {
    let second;
    const first = lockOrError({
      // The first starter holds the takeover guard and has not yet replaced the stale lock.
      holdingGuard: () => {
        second = lockOrError();
      }
    });

    expect(first).not.toBeInstanceOf(Error);
    expect(second).toBeInstanceOf(Error);
    expect(second.message).toMatch(/may be starting with this data folder \(pid \d+\)/);
    expect(readdirSync(dir)).toEqual(["server.lock"]);
  });

  it("three starters: a replacement live lock is never moved, so exactly one runs", () => {
    // A saw the stale lock; B then replaced it with its own live lock; C starts while A is
    // re-checking under the guard. A must not move B's lock aside, or C would find the path empty.
    let b;
    let c;
    let bInode;
    const a = lockOrError({
      beforeClaim: () => {
        b = lockOrError();
        bInode = statSync(file).ino;
      },
      holdingGuard: () => {
        c = lockOrError();
      }
    });

    expect(b).not.toBeInstanceOf(Error);
    expect(a).toBeInstanceOf(Error);
    expect(c).toBeInstanceOf(Error);
    // B's lock file itself was never moved or replaced.
    expect(statSync(file).ino).toBe(bInode);
    expect(readdirSync(dir)).toEqual(["server.lock"]);
  });

  it("refuses to take over while a takeover guard is held, naming the file to delete", () => {
    const guard = `${file}.takeover`;
    const leftover =
      `An earlier start was interrupted and left ${guard}. If EasyTestData is not running, ` +
      "delete that file and try again.";

    // A dead pid: a starter crashed inside its takeover.
    writeFileSync(guard, `${deadPid}\n`);
    expect(lockOrError().message).toBe(leftover);

    // A live pid: another starter is taking over right now, or a crashed starter's pid has been
    // reused by an unrelated process. The user cannot tell which, so the same instruction applies.
    writeFileSync(guard, `${process.pid}\n`);
    expect(lockOrError().message).toBe(
      `Another copy of EasyTestData may be starting with this data folder (pid ${process.pid}). ` +
        `Or an earlier start was interrupted and left ${guard}. If EasyTestData is not running, ` +
        "delete that file and try again."
    );
    expect(lockOrError().message).toContain(
      `earlier start was interrupted and left ${guard}. If EasyTestData is not running, delete that file and try again.`
    );
    // Nothing was touched: the stale lock and the guard are both still there.
    expect(readdirSync(dir).sort()).toEqual(["server.lock", "server.lock.takeover"]);

    unlinkSync(guard);
    expect(lockOrError()).not.toBeInstanceOf(Error);
  });

  it("creates its lock when another starter claimed the stale one first (it vanished)", () => {
    const lock = lockOrError({ beforeClaim: () => unlinkSync(file) });

    expect(lock).not.toBeInstanceOf(Error);
    expect(readdirSync(dir)).toEqual(["server.lock"]);
  });
});

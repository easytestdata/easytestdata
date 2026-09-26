import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { lockDataDir } from "../src/local/instance-lock.js";

// One local server per data dir: a second `easytestdata ui` on the same folder (any port) must
// refuse before it opens PGlite, migrates or closes out the first one's running jobs. The first
// server runs in this process (startLocalServer, temp data dir, never ~/.easytestdata); the
// second is a real separate process, as it would be for a user.
const root = mkdtempSync(join(tmpdir(), "eztd-server-lock-"));
const dataDir = join(root, "data");
const FIRST_PORT = 28189;
const SECOND_PORT = 28190;
vi.stubEnv("JWT_SECRET", "");
vi.stubEnv("TOKEN_ENCRYPTION_KEY", "");
vi.stubEnv("JOB_ARTIFACTS_DIR", "");
vi.stubEnv("LOCAL_PUBLIC_URL", "");
vi.stubEnv("LOG_LEVEL", "silent");

const startLocal = new URL("../src/local/start-local.js", import.meta.url).href;
const migrateScript = fileURLToPath(new URL("../src/db/migrate.js", import.meta.url));

/** Runs `node src/db/migrate.js` (what `pnpm run migrate` runs) in local mode on `dir`. */
function migrateInChild(dir) {
  return new Promise((resolve) => {
    const env = { ...process.env, DEPLOYMENT: "local", EASYTESTDATA_DATA_DIR: dir };
    env.LOG_LEVEL = "fatal";
    delete env.DATABASE_URL;
    const child = spawn(process.execPath, [migrateScript], {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => resolve({ code, output }));
  });
}

/** Runs startLocalServer in a child process; resolves { code, stdout, stderr }. */
function startInChild(dir, port) {
  const script = `
    import { existsSync, readFileSync } from "node:fs";
    const { startLocalServer } = await import(${JSON.stringify(startLocal)});
    const lockFile = ${JSON.stringify(join(dir, "server.lock"))};
    try {
      const server = await startLocalServer({ port: ${port}, dataDir: ${JSON.stringify(dir)}, open: false });
      const lockPid = Number(readFileSync(lockFile, "utf8"));
      await server.close();
      console.log(JSON.stringify({ started: true, lockPid, pid: process.pid, lockAfterClose: existsSync(lockFile) }));
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, LOG_LEVEL: "silent" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("one local server per data folder", () => {
  let server;
  let db;

  beforeAll(async () => {
    const { startLocalServer } = await import("../src/local/start-local.js");
    server = await startLocalServer({ port: FIRST_PORT, dataDir, open: false });
    db = await import("../src/db/pool.js");
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("holds <dataDir>/server.lock (0600) with its pid while running", () => {
    const file = join(dataDir, "server.lock");
    expect(Number(readFileSync(file, "utf8"))).toBe(process.pid);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    // Written through a temp file and linked into place: no temp file is left behind.
    expect(readdirSync(dataDir).filter((f) => f.startsWith("server.lock"))).toEqual([
      "server.lock"
    ]);
  });

  it("refuses a second server on the same data folder and leaves the first one's running job alone", async () => {
    const { getLocalIdentity } = await import("../src/local/identity.js");
    const { teamId } = await getLocalIdentity();
    const { rows } = await db.query(
      "INSERT INTO jobs (team_id, type, status, started_at) VALUES ($1, 'generate', 'running', NOW()) RETURNING id",
      [teamId]
    );

    const second = await startInChild(dataDir, SECOND_PORT);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain(
      `EasyTestData is already running with this data folder (pid ${process.pid}). Stop it ` +
        "first, or use --data-dir for a separate copy."
    );

    const job = (await db.query("SELECT status, error FROM jobs WHERE id = $1", [rows[0].id]))
      .rows[0];
    expect(job).toEqual({ status: "running", error: null });
    // The first server still owns the folder and still answers.
    expect(Number(readFileSync(join(dataDir, "server.lock"), "utf8"))).toBe(process.pid);
    expect((await fetch(`http://localhost:${FIRST_PORT}/health`)).status).toBe(200);
  }, 60_000);

  it("takes over a lock left by a process that is gone, and removes it on close()", async () => {
    const other = join(root, "stale");
    mkdirSync(other, { recursive: true, mode: 0o700 });
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(join(other, "server.lock"), `${deadPid}\n`);

    const result = await startInChild(other, SECOND_PORT);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.started).toBe(true);
    expect(report.lockPid).toBe(report.pid);
    expect(report.lockAfterClose).toBe(false);
  }, 60_000);

  it("refuses a directly run migrate while the server has the data folder", async () => {
    const result = await migrateInChild(dataDir);
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      `EasyTestData is already running with this data folder (pid ${process.pid})`
    );
    expect(Number(readFileSync(join(dataDir, "server.lock"), "utf8"))).toBe(process.pid);
  }, 60_000);

  it("lets migrate take and release the lock on a free data folder", async () => {
    const other = join(root, "migrate-only");
    const result = await migrateInChild(other);
    expect(result.output).toBe("");
    expect(result.code).toBe(0);
    expect(existsSync(join(other, "db"))).toBe(true);
    expect(existsSync(join(other, "server.lock"))).toBe(false);
  }, 60_000);

  it("treats an unreadable lock as held while it is fresh, and as stale once it is old", async () => {
    const other = join(root, "unreadable");
    mkdirSync(other, { recursive: true });
    const file = join(other, "server.lock");
    writeFileSync(file, "");
    expect(() => lockDataDir(other)).toThrow(
      "EasyTestData is already running with this data folder"
    );
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    const lock = lockDataDir(other);
    expect(Number(readFileSync(file, "utf8"))).toBe(process.pid);
    await lock.release();
    expect(existsSync(file)).toBe(false);
  });

  it("never removes a lock file another process holds", async () => {
    const other = join(root, "foreign");
    mkdirSync(other, { recursive: true });
    const lock = lockDataDir(other);
    writeFileSync(join(other, "server.lock"), "1\n"); // replaced behind our back
    await lock.release();
    expect(existsSync(join(other, "server.lock"))).toBe(true);
  });

  it("removes its lock file on close()", async () => {
    await server.close();
    server = null;
    expect(existsSync(join(dataDir, "server.lock"))).toBe(false);
  });
});

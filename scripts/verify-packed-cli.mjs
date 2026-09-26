// Packs the published packages, installs the tarballs (production dependencies only) into a temp
// project outside the workspace, runs `easytestdata ui` from there and checks that it serves the
// app. Catches files missing from a package's "files", workspace-only imports and devDependencies
// used at runtime, and checks that the packed @easytestdata/shared exposes only JavaScript entry
// points that exist in its tarball, each with its .d.ts (Node cannot load its TypeScript sources,
// and strict TypeScript consumers need the declarations; scripts/shared-entry-points.mjs). Needs
// the web app built first (`pnpm run build`); `npm install` downloads the
// third-party dependencies from the registry.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sharedEntryPointProblems } from "./shared-entry-points.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
/** Published package name → its directory in the workspace. */
const PACKAGE_DIRS = {
  "@easytestdata/core": "packages/core",
  "@easytestdata/qbo-client": "packages/qbo-client",
  "@easytestdata/shared": "packages/shared",
  "@easytestdata/server": "packages/server",
  easytestdata: "packages/cli"
};
const PACKAGES = Object.keys(PACKAGE_DIRS);
const PORT = 28182;
const HEALTH_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 20_000;

const work = mkdtempSync(join(tmpdir(), "eztd-packed-"));
const tarballDir = join(work, "tarballs");
const project = join(work, "project");
const dataDir = join(work, "data");
let child = null;

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`easytestdata ui exited (${child.exitCode})`);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error(`/health did not answer 200 within ${HEALTH_TIMEOUT_MS / 1000} s`);
}

/** Sends `signal` and resolves the exit code, or null when the process outlives the timeout. */
function stop(signal) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), EXIT_TIMEOUT_MS);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.kill(signal);
  });
}

/**
 * The packed @easytestdata/shared: its entry points follow sharedEntryPointProblems (JavaScript
 * that ships, with declarations, and no TypeScript source; those entry points are workspace-only:
 * publishConfig.exports replaces the workspace exports when pnpm packs).
 */
function verifyPackedShared(tarball) {
  const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const files = new Set(listing.map((entry) => entry.replace(/^package\//, "")));
  const manifest = JSON.parse(
    execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" })
  );
  const problems = sharedEntryPointProblems(manifest, files);
  if (problems.length > 0) {
    throw new Error(`the packed @easytestdata/shared: ${problems.join("; ")}`);
  }
  console.log("Packed @easytestdata/shared exports only JavaScript, each with its declarations");
}

async function main() {
  console.log(`Packing ${PACKAGES.join(", ")} into ${tarballDir}`);
  for (const name of PACKAGES) {
    // pnpm pack (not npm pack) rewrites workspace:* to real versions and runs prepack.
    run("pnpm", ["pack", "--pack-destination", tarballDir], join(repoRoot, PACKAGE_DIRS[name]));
  }
  const tarballs = readdirSync(tarballDir).filter((file) => file.endsWith(".tgz"));
  if (tarballs.length !== PACKAGES.length) {
    throw new Error(`expected ${PACKAGES.length} tarballs, got: ${tarballs.join(", ")}`);
  }

  // Every @easytestdata package (and the CLI) resolves to its tarball, never to the registry.
  const local = Object.fromEntries(
    PACKAGES.map((name) => {
      const prefix = name.replace("@", "").replace("/", "-");
      const file = tarballs.find((t) => new RegExp(`^${prefix}-\\d`).test(t));
      if (!file) throw new Error(`no tarball for ${name}`);
      return [name, `file:${join(tarballDir, file)}`];
    })
  );
  verifyPackedShared(local["@easytestdata/shared"].replace(/^file:/, ""));
  mkdirSync(project);
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify(
      // Only the CLI is a direct dependency, as with `npm i -g easytestdata`: the other packages
      // arrive through the CLI's own dependencies (so a missing one fails here), and the
      // overrides point them at their tarballs.
      {
        name: "eztd-packed-check",
        private: true,
        dependencies: { easytestdata: local.easytestdata },
        overrides: local
      },
      null,
      2
    )
  );
  console.log(`Installing the tarballs into ${project} (npm install --omit=dev)`);
  run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], project);

  // The CLI must not drag in the web app's React stack (shared's react-query is an optional peer).
  for (const name of ["@tanstack/react-query", "react"]) {
    if (existsSync(join(project, "node_modules", name))) {
      throw new Error(`the packed install pulled in ${name}`);
    }
  }

  const bin = join(project, "node_modules", "easytestdata", "bin", "easytestdata.js");
  // A clean environment: nothing from this shell (DATABASE_URL, APP_URL, LOG_LEVEL, ...) leaks
  // into the run, so the CLI's own defaults (NODE_ENV=production, quiet logs) apply.
  const env = { PATH: process.env.PATH, HOME: work };
  console.log(`Starting easytestdata ui on port ${PORT}`);
  child = spawn(
    process.execPath,
    [bin, "ui", "--port", String(PORT), "--no-open", "--data-dir", dataDir],
    { cwd: project, env, stdio: ["ignore", "pipe", "inherit"] }
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });

  await waitForHealth();
  const page = await fetch(`http://localhost:${PORT}/`);
  const html = await page.text();
  if (page.status !== 200 || !html.includes('<div id="root">')) {
    throw new Error(`GET / answered ${page.status} without the app's HTML`);
  }
  const profile = await fetch(`http://localhost:${PORT}/api/v1/auth/profile`, {
    headers: { "x-easytestdata": "1" }
  });
  if (profile.status !== 200)
    throw new Error(`GET /api/v1/auth/profile answered ${profile.status}`);

  const code = await stop("SIGINT");
  if (code !== 0) throw new Error(`Ctrl+C did not stop the server cleanly (exit ${code})`);
  // The user's terminal shows warnings and errors, never a log line per request.
  if (output.includes('"req":{')) throw new Error("easytestdata ui logged requests to stdout");
  if (!output.includes(`EasyTestData is running at http://localhost:${PORT}`)) {
    throw new Error("easytestdata ui did not print its URL");
  }
  console.log("Packed install OK: the CLI serves the app and stops cleanly on Ctrl+C");
}

try {
  await main();
} catch (err) {
  console.error(`test:packed FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && (await stop("SIGKILL")) === null) {
    console.error(`could not stop the easytestdata ui process (pid ${child.pid})`);
    process.exitCode = 1;
  }
  rmSync(work, { recursive: true, force: true });
}

import fs from "fs/promises";
import path from "path";
import { strToU8, zipSync } from "fflate";
import { exportToCsv, exportToJson } from "@easytestdata/core";
import { config } from "../config.js";

/**
 * Where download files live: JOB_ARTIFACTS_DIR, else `<dataDir>/exports` in local mode (so
 * deleting the data dir resets everything), else `./data/exports`. Read on every call.
 */
export function getArtifactDir() {
  if (process.env.JOB_ARTIFACTS_DIR) return process.env.JOB_ARTIFACTS_DIR;
  return config.deployment === "local"
    ? path.join(config.dataDir, "exports")
    : path.resolve(process.cwd(), "data", "exports");
}

async function ensureArtifactDir() {
  await fs.mkdir(getArtifactDir(), { recursive: true });
}

export const ARTIFACT_FORMATS = ["json", "csv"];

export function normalizeArtifactFormat(format) {
  return format === "csv" ? "csv" : "json";
}

function artifactFilename(jobId, format) {
  return format === "csv" ? `${jobId}-csv.zip` : `${jobId}.json`;
}

/**
 * Zips one CSV file per record type (customers.csv, invoices.csv, invoice_lines.csv, ...), the
 * same layout `easytestdata generate --format csv` writes, so each file opens in a spreadsheet.
 */
export function buildCsvArtifactZip(plan) {
  const files = {};
  for (const [name, csv] of Object.entries(exportToCsv(plan))) {
    files[`${name}.csv`] = strToU8(csv);
  }
  return zipSync(files, { level: 6 });
}

/**
 * Writes one artifact file and returns its descriptor. The descriptor is stored in the job result
 * and sent to clients, so it holds only the filename, never the server's absolute path;
 * resolveArtifactPath maps it back to the file.
 */
export async function writeJobArtifact(jobId, plan, format = "json", { signal } = {}) {
  await ensureArtifactDir();
  const safeFormat = normalizeArtifactFormat(format);

  if (safeFormat === "csv") {
    const filename = artifactFilename(jobId, "csv");
    const filePath = path.join(getArtifactDir(), filename);
    await fs.writeFile(filePath, buildCsvArtifactZip(plan), { signal });
    return {
      filename,
      mimeType: "application/zip",
      format: "csv"
    };
  }

  const filename = artifactFilename(jobId, "json");
  const filePath = path.join(getArtifactDir(), filename);
  await fs.writeFile(filePath, exportToJson(plan), { encoding: "utf8", signal });
  return {
    filename,
    mimeType: "application/json",
    format: "json"
  };
}

/**
 * Writes the plan in every downloadable format. `artifact` is the requested (primary) format;
 * `artifacts` maps each format to its file so the UI can offer JSON and CSV downloads.
 * `signal` (the job's timeout/cancel) stops the writing: the job's files, including a partly
 * written one, are removed and the abort reason is thrown.
 */
export async function writeJobArtifacts(jobId, plan, primaryFormat = "json", { signal } = {}) {
  const artifacts = {};
  try {
    for (const format of ARTIFACT_FORMATS) {
      signal?.throwIfAborted();
      artifacts[format] = await writeJobArtifact(jobId, plan, format, { signal });
    }
    signal?.throwIfAborted();
  } catch (err) {
    if (signal?.aborted) {
      await removeJobArtifacts(jobId);
      throw signal.reason;
    }
    throw err;
  }
  return { artifact: artifacts[normalizeArtifactFormat(primaryFormat)], artifacts };
}

/** Deletes a job's artifact files (any that exist). */
export async function removeJobArtifacts(jobId) {
  const dir = getArtifactDir();
  await Promise.all(
    ARTIFACT_FORMATS.map((format) =>
      fs.rm(path.join(dir, artifactFilename(jobId, format)), { force: true })
    )
  );
}

/**
 * Picks the stored artifact for a download. Without `format`, returns the primary artifact.
 * Returns null when the job has no artifact in that format.
 */
export function selectArtifact(result, format) {
  if (!result) return null;
  if (!format) return result.artifact ?? null;
  if (!ARTIFACT_FORMATS.includes(format)) return null;
  if (result.artifacts?.[format]) return result.artifacts[format];
  return result.artifact?.format === format ? result.artifact : null;
}

/**
 * Deletes export artifacts (the per-job .json and CSV .zip files) older than `ttlDays`. Runs on a
 * repeatable worker job; a download for a deleted artifact then returns 404.
 */
export async function cleanupExpiredArtifacts({
  ttlDays,
  dir = getArtifactDir(),
  now = Date.now()
}) {
  const cutoff = now - ttlDays * 24 * 60 * 60 * 1000;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return { deleted: 0, kept: 0 };
    throw err;
  }

  let deleted = 0;
  let kept = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(json|csv|zip)$/.test(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(filePath);
        deleted++;
      } else {
        kept++;
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  return { deleted, kept };
}

export async function resolveArtifactPath(artifact) {
  if (!artifact?.filename) return null;
  const dir = path.resolve(getArtifactDir());
  const filePath = path.resolve(dir, artifact.filename);
  // Prevent path traversal
  if (!filePath.startsWith(dir + path.sep)) return null;
  try {
    await fs.access(filePath);
    return filePath;
  } catch {
    return null;
  }
}

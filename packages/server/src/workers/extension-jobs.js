import { query } from "../db/pool.js";

// Extension job handlers by "<extension>/<kind>", set by bootstrap from validated descriptors
// before the job runner starts. A job row names its handler in config { extension, kind }.
const handlers = new Map();

export function registerExtensionJobs(extensions = []) {
  handlers.clear();
  for (const extension of extensions) {
    for (const [kind, job] of Object.entries(extension.jobs ?? {})) {
      handlers.set(`${extension.name}/${kind}`, job);
    }
  }
}

function parseConfig(config) {
  if (typeof config !== "string") return config ?? {};
  try {
    return JSON.parse(config);
  } catch {
    return {};
  }
}

/** The handler a job row names, with its payload; `handler` is null when none is registered. */
export function resolveExtensionJob(jobConfig) {
  const { extension, kind, payload = {} } = parseConfig(jobConfig);
  const handler = handlers.get(`${extension}/${kind}`) ?? null;
  return { extension, kind, payload, handler };
}

/** The registered timeout of an extension job row in ms, or null (not an extension job). */
export async function extensionJobTimeoutMs(jobId) {
  if (handlers.size === 0) return null;
  const { rows } = await query("SELECT type, config FROM jobs WHERE id = $1", [jobId]);
  const row = rows[0];
  if (!row || row.type !== "extension") return null;
  const minutes = resolveExtensionJob(row.config).handler?.timeoutMinutes;
  return minutes ? minutes * 60 * 1000 : null;
}

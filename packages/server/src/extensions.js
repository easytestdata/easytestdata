export const EXTENSION_NAME = /^[a-z][a-z0-9-]{1,30}$/;

const RESERVED_NAMES = new Set([
  "auth",
  "connections",
  "jobs",
  "templates",
  "teams",
  "admin",
  "setup",
  "config",
  "health"
]);

function validateName(name) {
  if (typeof name !== "string" || !EXTENSION_NAME.test(name)) {
    throw new Error(`Extension name must match ${EXTENSION_NAME}`);
  }
  if (RESERVED_NAMES.has(name)) throw new Error(`Extension name ${name} is reserved`);
}

/** Validate descriptors before migrations or lifecycle hooks can have side effects. */
export function validateExtensions(extensions) {
  if (!Array.isArray(extensions)) throw new Error("Extensions must be an array");
  const names = new Set();
  for (const extension of extensions) {
    if (
      extension === null ||
      typeof extension !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(extension))
    ) {
      throw new Error("Each extension descriptor must be a plain object");
    }
    validateName(extension.name);
    if (names.has(extension.name)) throw new Error(`Duplicate extension name ${extension.name}`);
    names.add(extension.name);
    for (const hook of ["router", "onStart", "onStopping", "onStop"]) {
      if (extension[hook] !== undefined && typeof extension[hook] !== "function") {
        throw new Error(`Extension ${extension.name} ${hook} must be a function`);
      }
    }
    validateJobs(extension);
    if (
      extension.migrationsDir !== undefined &&
      (typeof extension.migrationsDir !== "string" || extension.migrationsDir.trim() === "")
    ) {
      throw new Error(`Extension ${extension.name} migrationsDir must be a non-empty string`);
    }
  }
  return extensions;
}

export const MAX_EXTENSION_JOB_MINUTES = 240;

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

// `jobs`: { [kind]: { run(ctx), needsSandbox, timeoutMinutes? } }, run by the shared job runner.
function validateJobs(extension) {
  if (extension.jobs === undefined) return;
  if (!isPlainObject(extension.jobs)) {
    throw new Error(`Extension ${extension.name} jobs must be a plain object`);
  }
  for (const [kind, job] of Object.entries(extension.jobs)) {
    if (!EXTENSION_NAME.test(kind)) {
      throw new Error(`Extension ${extension.name} job kind ${kind} must match ${EXTENSION_NAME}`);
    }
    if (!isPlainObject(job) || typeof job.run !== "function") {
      throw new Error(`Extension ${extension.name} job ${kind} must have a run function`);
    }
    if (typeof job.needsSandbox !== "boolean") {
      throw new Error(`Extension ${extension.name} job ${kind} needsSandbox must be a boolean`);
    }
    if (
      job.timeoutMinutes !== undefined &&
      (!Number.isInteger(job.timeoutMinutes) ||
        job.timeoutMinutes < 1 ||
        job.timeoutMinutes > MAX_EXTENSION_JOB_MINUTES)
    ) {
      throw new Error(
        `Extension ${extension.name} job ${kind} timeoutMinutes must be an integer from 1 to ${MAX_EXTENSION_JOB_MINUTES}`
      );
    }
  }
}

export function migrationTableName(name) {
  validateName(name);
  return `_migrations_${name.replaceAll("-", "_")}`;
}

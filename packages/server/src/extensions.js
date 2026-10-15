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
    if (
      extension.migrationsDir !== undefined &&
      (typeof extension.migrationsDir !== "string" || extension.migrationsDir.trim() === "")
    ) {
      throw new Error(`Extension ${extension.name} migrationsDir must be a non-empty string`);
    }
  }
  return extensions;
}

export function migrationTableName(name) {
  validateName(name);
  return `_migrations_${name.replaceAll("-", "_")}`;
}

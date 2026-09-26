// Rules for the entry points the packed @easytestdata/shared exposes, used by
// verify-packed-cli.mjs on the real tarball and unit-tested in packages/cli/tests.

/**
 * Problems with `manifest` (the packed package.json) given the tarball's `files` (paths without
 * the "package/" prefix): every `exports`/`main` path must be .js or .d.ts and ship in the
 * tarball, every JavaScript entry point must come with its declarations (a `types` condition or
 * `types` field naming a shipped .d.ts, else a .d.ts next to the .js) so strict TypeScript
 * consumers get types, and no TypeScript source may ship. Returns [] when all is well.
 */
export function sharedEntryPointProblems(manifest, files) {
  const problems = [];
  const shipped = (path) => files.has(path.replace(/^\.\//, ""));
  const entries = []; // { name, js, types }
  const add = (name, target) => {
    if (typeof target === "string") entries.push({ name, js: target, types: null });
    else if (target && typeof target === "object") {
      const js = target.import || target.default || target.require || null;
      entries.push({ name, js, types: target.types || null });
      for (const [condition, value] of Object.entries(target)) {
        if (!["import", "default", "require", "types"].includes(condition)) add(name, value);
      }
    }
  };
  const exportsField = manifest.exports;
  if (typeof exportsField === "string" || exportsField?.import || exportsField?.default) {
    add(".", exportsField);
  } else {
    for (const [name, target] of Object.entries(exportsField || {})) add(name, target);
  }
  if (manifest.main) entries.push({ name: "main", js: manifest.main, types: manifest.types });
  if (entries.length === 0) return ["exports nothing"];

  for (const { name, js, types } of entries) {
    for (const path of [js, types].filter(Boolean)) {
      if (!/\.(js|d\.ts)$/.test(path)) problems.push(`${name}: ${path} is not JavaScript`);
      else if (!shipped(path)) problems.push(`${name}: ${path} is missing from the tarball`);
    }
    if (js && /\.js$/.test(js) && !/\.d\.ts$/.test(js)) {
      const declarations = types || js.replace(/\.js$/, ".d.ts");
      if (!/\.d\.ts$/.test(declarations) || !shipped(declarations)) {
        problems.push(`${name}: ${js} ships without declarations (${declarations})`);
      }
    }
  }
  const sources = [...files].filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".d.ts"));
  if (sources.length > 0) problems.push(`ships TypeScript: ${sources.join(", ")}`);
  return [...new Set(problems)];
}

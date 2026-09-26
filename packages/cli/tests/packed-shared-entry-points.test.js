import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { sharedEntryPointProblems } from "../../../scripts/shared-entry-points.mjs";

// The rule test:packed applies to the packed @easytestdata/shared (scripts/verify-packed-cli.mjs),
// checked here on every test run: on made-up manifests, and on the real package as pnpm would
// pack it (publishConfig.exports, the files matching its "files" globs).

const sharedDir = fileURLToPath(new URL("../../shared/", import.meta.url));

describe("sharedEntryPointProblems", () => {
  const files = new Set(["src/a.js", "src/a.d.ts", "src/b.js", "src/c.js", "src/types.d.ts"]);

  it("accepts JavaScript entry points with adjacent or named declarations", () => {
    const manifest = {
      main: "src/a.js",
      exports: { ".": "./src/a.js", "./c": { types: "./src/types.d.ts", default: "./src/c.js" } }
    };
    expect(sharedEntryPointProblems(manifest, files)).toEqual([]);
  });

  it("names a JavaScript entry point that ships without declarations", () => {
    expect(sharedEntryPointProblems({ exports: { "./b": "./src/b.js" } }, files)).toEqual([
      "./b: ./src/b.js ships without declarations (./src/b.d.ts)"
    ]);
    expect(
      sharedEntryPointProblems(
        { exports: { "./c": { types: "./src/missing.d.ts", default: "./src/c.js" } } },
        files
      )
    ).toContain("./c: ./src/missing.d.ts is missing from the tarball");
  });

  it("refuses TypeScript entry points and sources, missing files and an empty package", () => {
    const problems = sharedEntryPointProblems(
      { exports: { "./t": "./src/types.ts", "./gone": "./src/gone.js" } },
      new Set([...files, "src/types.ts"])
    );
    expect(problems).toContain("./t: ./src/types.ts is not JavaScript");
    expect(problems).toContain("./gone: ./src/gone.js is missing from the tarball");
    expect(problems).toContain("ships TypeScript: src/types.ts");
    expect(sharedEntryPointProblems({}, files)).toEqual(["exports nothing"]);
  });
});

describe("the real @easytestdata/shared as packed", () => {
  const pkg = JSON.parse(readFileSync(join(sharedDir, "package.json"), "utf8"));
  const shippedFiles = () => {
    // package.json "files": src/**/*.js, src/**/*.d.ts, LICENSE, NOTICE (pnpm adds package.json).
    const found = new Set(["package.json", "LICENSE", "NOTICE"]);
    (function walk(dir) {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(js|d\.ts)$/.test(name)) found.add(relative(sharedDir, path));
      }
    })(join(sharedDir, "src"));
    return found;
  };

  it("lists the files globs this test mirrors", () => {
    expect(pkg.files).toEqual(["src/**/*.js", "src/**/*.d.ts", "LICENSE", "NOTICE"]);
  });

  it("ships every published JavaScript entry point with its declarations", () => {
    const manifest = { ...pkg, exports: pkg.publishConfig.exports };
    expect(sharedEntryPointProblems(manifest, shippedFiles())).toEqual([]);
  });

  it("declares every name each entry point exports", async () => {
    // Names declared by a .d.ts, following `export * from` and `export { ... } from`.
    const declared = (file) => {
      const text = readFileSync(file, "utf8");
      const names = new Set();
      for (const m of text.matchAll(
        /export (?:declare )?(?:const|function|class|type|interface) (\w+)/g
      )) {
        names.add(m[1]);
      }
      for (const m of text.matchAll(/export \{([^}]*)\}/g)) {
        for (const name of m[1].split(","))
          names.add(
            name
              .trim()
              .split(/\s+as\s+/)
              .pop()
          );
      }
      for (const m of text.matchAll(/export \* from "(.+?)"/g)) {
        const target = join(dirname(file), m[1].replace(/\.js$/, ".d.ts"));
        for (const name of declared(target)) names.add(name);
      }
      return names;
    };
    for (const [entry, target] of Object.entries(pkg.publishConfig.exports)) {
      const js = join(sharedDir, target.default);
      const dts = join(sharedDir, target.types);
      expect(existsSync(dts), `${entry}: ${target.types}`).toBe(true);
      const runtime = Object.keys(await import(pathToFileURL(js).href));
      const missing = runtime.filter((name) => !declared(dts).has(name));
      expect(missing, `${entry} exports undeclared names`).toEqual([]);
    }
  });
});

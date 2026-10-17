// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, type UserConfig } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import publicConfig, { createWebConfig } from "../../vite.config";
import type { BrandMetadata } from "./types";

const webDir = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const indexHtml = readFileSync(join(webDir, "index.html"), "utf8");
const metadata: BrandMetadata = {
  name: "EasyTestData",
  description: "Realistic test data for QuickBooks Online sandboxes.",
  repoUrl: "https://github.com/easytestdata/easytestdata",
  supportsSourceReads: false
};
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "eztd-web-config-"));
});
afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

function brandFile(value: unknown) {
  const path = join(tempDir, "brand.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

async function transformHtml(config: UserConfig) {
  const resolved = await resolveConfig({ ...config, configFile: false }, "build");
  const plugins = resolved.plugins.filter((plugin) => plugin.transformIndexHtml);
  // Run only this slot's hook, without starting a dev server or Vite's asset rewriting.
  const plugin = plugins.find((plugin) => plugin.name === "web-brand-metadata");
  expect(plugin).toBeDefined();
  const hook = plugin!.transformIndexHtml!;
  const handler = typeof hook === "function" ? hook : hook.handler;
  return Reflect.apply(handler, {}, [
    indexHtml,
    { path: "/", filename: join(webDir, "index.html") }
  ]);
}

describe("createWebConfig", () => {
  it.each([false, true])(
    "dedupes shared context packages with an external build: %s",
    (external) => {
      const config = createWebConfig(
        external
          ? {
              rootDir: tempDir,
              extensionModule: join(tempDir, "extensions.ts"),
              brandFile: brandFile(metadata)
            }
          : {}
      );
      expect(config.resolve?.dedupe).toEqual([
        "react",
        "react-dom",
        "react-router-dom",
        "@tanstack/react-query"
      ]);
    }
  );

  it("preserves absolute public paths, aliases, port, proxy and sourcemaps", async () => {
    const config = createWebConfig();
    expect(publicConfig).toMatchObject({
      root: webDir,
      publicDir: join(webDir, "public"),
      server: {
        port: 5173,
        proxy: { "/api": { target: "http://localhost:28080", changeOrigin: false } }
      },
      build: { outDir: join(webDir, "dist"), sourcemap: true }
    });
    expect(config.resolve?.alias).toEqual({
      "@": join(webDir, "src"),
      "@ui": resolve(webDir, "../ui/src"),
      "@easytestdata/web-extensions": join(webDir, "src/extensions/default.ts"),
      "@easytestdata/web-brand": join(webDir, "src/extensions/default-brand.json")
    });
    for (const path of Object.values(config.resolve!.alias!)) expect(isAbsolute(path)).toBe(true);
    const resolved = await resolveConfig({ ...config, configFile: false }, "build");
    expect(resolved.plugins.some((plugin) => plugin.name.startsWith("vite:react"))).toBe(true);
    expect(resolved.plugins.some((plugin) => plugin.name.startsWith("@tailwindcss/vite"))).toBe(
      true
    );
    expect(await transformHtml(config)).toBe(indexHtml);
  });

  it("accepts a separate app root and absolute paths while keeping shared source aliases", () => {
    const extensionModule = join(tempDir, "extensions.ts");
    const file = brandFile(metadata);
    const config = createWebConfig({
      rootDir: tempDir,
      extensionModule,
      brandFile: file,
      outDir: join(tempDir, "output"),
      publicDir: join(tempDir, "static"),
      port: 5174,
      apiTarget: "http://localhost:28081"
    });
    expect(config).toMatchObject({
      root: tempDir,
      publicDir: join(tempDir, "static"),
      resolve: {
        alias: {
          "@": join(webDir, "src"),
          "@ui": resolve(webDir, "../ui/src"),
          "@easytestdata/web-extensions": extensionModule,
          "@easytestdata/web-brand": file
        }
      },
      server: {
        port: 5174,
        proxy: { "/api": { target: "http://localhost:28081", changeOrigin: false } }
      },
      build: { outDir: join(tempDir, "output"), sourcemap: true }
    });
  });

  it("resolves relative path options from rootDir and defaults assets to that root", () => {
    brandFile(metadata);
    const config = createWebConfig({
      rootDir: tempDir,
      extensionModule: "extensions.ts",
      brandFile: "brand.json",
      outDir: "output",
      publicDir: "static"
    });
    expect(config).toMatchObject({
      publicDir: join(tempDir, "static"),
      resolve: {
        alias: {
          "@easytestdata/web-extensions": join(tempDir, "extensions.ts"),
          "@easytestdata/web-brand": join(tempDir, "brand.json")
        }
      },
      build: { outDir: join(tempDir, "output") }
    });
    expect(createWebConfig({ rootDir: tempDir })).toMatchObject({
      publicDir: join(tempDir, "public"),
      build: { outDir: join(tempDir, "dist") }
    });
  });

  it("escapes metadata in the existing title and description without adding duplicate tags", async () => {
    const value = `A & B <demo> "quoted" 'single' $&`;
    const config = createWebConfig({
      brandFile: brandFile({ ...metadata, name: value, description: value })
    });
    const html = await transformHtml(config);
    const escaped = "A &amp; B &lt;demo&gt; &quot;quoted&quot; &#39;single&#39; $&amp;";
    expect(html).toContain(`<title>${escaped}</title>`);
    expect(html).toContain(`<meta name="description" content="${escaped}" />`);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/name="description"/g)).toHaveLength(1);
    expect(html).toContain('<meta name="theme-color" content="#2563eb" />');
    expect(html).toContain('<script type="module" src="/src/main.tsx"></script>');
  });

  it.each([
    ["name", 42, "Example"],
    ["name", null, "Example"],
    ["description", false, "Description"],
    ["description", null, "Description"],
    ["repoUrl", 42, "https://example.com/repo"],
    ["repoUrl", false, null],
    ["supportsSourceReads", "false", false],
    ["supportsSourceReads", null, true]
  ])("rejects invalid %s (%j) and accepts its valid companion", (field, invalid, valid) => {
    expect(() =>
      createWebConfig({ brandFile: brandFile({ ...metadata, [field]: invalid }) })
    ).toThrow();
    expect(() =>
      createWebConfig({ brandFile: brandFile({ ...metadata, [field]: valid }) })
    ).not.toThrow();
  });

  it.each(["name", "description", "repoUrl", "supportsSourceReads"])(
    "rejects missing %s and accepts it when supplied",
    (field) => {
      const missing: Record<string, unknown> = { ...metadata };
      delete missing[field];
      expect(() => createWebConfig({ brandFile: brandFile(missing) })).toThrow();
      expect(() => createWebConfig({ brandFile: brandFile(metadata) })).not.toThrow();
    }
  );

  it.each([{ value: null }, { value: [] }, { value: "brand" }, { value: 42 }])(
    "rejects non-object metadata $value and accepts an object",
    ({ value }) => {
      expect(() => createWebConfig({ brandFile: brandFile(value) })).toThrow();
      expect(() => createWebConfig({ brandFile: brandFile(metadata) })).not.toThrow();
    }
  );

  it.each([
    { companionUrl: "https://example.com" },
    { companionLabel: "Companion" },
    { companionUrl: 42, companionLabel: "Companion" },
    { companionUrl: "https://example.com", companionLabel: false },
    { companionUrl: null, companionLabel: null }
  ])(
    "rejects unpaired or invalid companion fields %j and accepts both strings or neither",
    (fields) => {
      expect(() => createWebConfig({ brandFile: brandFile({ ...metadata, ...fields }) })).toThrow();
      expect(() =>
        createWebConfig({
          brandFile: brandFile({
            ...metadata,
            companionUrl: "https://example.com",
            companionLabel: "Companion"
          })
        })
      ).not.toThrow();
      expect(() => createWebConfig({ brandFile: brandFile(metadata) })).not.toThrow();
    }
  );

  it.each([{ teams: "no" }, { teams: null }, { teams: 0 }])(
    "rejects a non-boolean teams %j and accepts true, false or absent",
    (fields) => {
      expect(() => createWebConfig({ brandFile: brandFile({ ...metadata, ...fields }) })).toThrow(
        /teams must be a boolean/
      );
      for (const teams of [true, false]) {
        expect(() =>
          createWebConfig({ brandFile: brandFile({ ...metadata, teams }) })
        ).not.toThrow();
      }
      expect(() => createWebConfig({ brandFile: brandFile(metadata) })).not.toThrow();
    }
  );

  it("rejects malformed JSON and accepts valid JSON at the same path", () => {
    const file = brandFile(metadata);
    writeFileSync(file, "{ broken");
    expect(() => createWebConfig({ brandFile: file })).toThrow();
    writeFileSync(file, JSON.stringify(metadata));
    expect(() => createWebConfig({ brandFile: file })).not.toThrow();
  });
});

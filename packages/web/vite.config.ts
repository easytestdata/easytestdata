import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrandMetadata } from "./src/extensions/types.ts";

const webDir = fileURLToPath(new URL(".", import.meta.url));

interface WebConfigOptions {
  rootDir?: string;
  extensionModule?: string;
  brandFile?: string;
  outDir?: string;
  publicDir?: string;
  port?: number;
  apiTarget?: string;
}

function readBrandMetadata(file: string): BrandMetadata {
  const metadata: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    !("name" in metadata) ||
    typeof metadata.name !== "string" ||
    !("description" in metadata) ||
    typeof metadata.description !== "string" ||
    !("repoUrl" in metadata) ||
    (metadata.repoUrl !== null && typeof metadata.repoUrl !== "string") ||
    !("supportsSourceReads" in metadata) ||
    typeof metadata.supportsSourceReads !== "boolean"
  ) {
    throw new Error(
      `Invalid brand metadata in ${file}: expected name and description strings, repoUrl string or null, and supportsSourceReads boolean.`
    );
  }
  const companionUrl = "companionUrl" in metadata ? metadata.companionUrl : undefined;
  const companionLabel = "companionLabel" in metadata ? metadata.companionLabel : undefined;
  if (
    (companionUrl !== undefined || companionLabel !== undefined) &&
    (typeof companionUrl !== "string" || typeof companionLabel !== "string")
  ) {
    throw new Error(
      `Invalid brand metadata in ${file}: companionUrl and companionLabel must be supplied together as strings.`
    );
  }
  return metadata as BrandMetadata;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function createWebConfig({
  rootDir = webDir,
  extensionModule = resolve(webDir, "src/extensions/default.ts"),
  brandFile = resolve(webDir, "src/extensions/default-brand.json"),
  outDir = "dist",
  publicDir = "public",
  port = 5173,
  apiTarget = "http://localhost:28080"
}: WebConfigOptions = {}) {
  const root = resolve(rootDir);
  const metadataFile = resolve(root, brandFile);
  const metadata = readBrandMetadata(metadataFile);

  return defineConfig({
    root,
    publicDir: resolve(root, publicDir),
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "web-brand-metadata",
        transformIndexHtml(html) {
          return html
            .replace(
              /<title>[\s\S]*?<\/title>/i,
              () => `<title>${escapeHtml(metadata.name)}</title>`
            )
            .replace(
              /<meta name="description" content="[^"]*"\s*\/?>/i,
              () => `<meta name="description" content="${escapeHtml(metadata.description)}" />`
            );
        }
      }
    ],
    resolve: {
      dedupe: ["react", "react-dom", "react-router-dom", "@tanstack/react-query"],
      alias: {
        "@": resolve(webDir, "src"),
        "@ui": resolve(webDir, "../ui/src"),
        "@easytestdata/web-extensions": resolve(root, extensionModule),
        "@easytestdata/web-brand": metadataFile
      }
    },
    server: {
      port,
      proxy: {
        // The server's dev script runs local mode on 28080. The Host header stays
        // localhost:5173 (changeOrigin: false), which local mode accepts as its public address
        // (LOCAL_PUBLIC_URL), so the Intuit redirect and OAuth popup share the page's origin.
        "/api": {
          target: apiTarget,
          changeOrigin: false
        }
      }
    },
    build: {
      outDir: resolve(root, outDir),
      sourcemap: true
    }
  });
}

export default createWebConfig();

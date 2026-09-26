import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// EasyTestData is sandbox-only by design. Besides the runtime guard (assertSandboxBaseUrl), this
// test makes "the production QuickBooks API address appears nowhere in the code" a CI rule: any
// `quickbooks.api.intuit.com` that is not `sandbox-quickbooks.api.intuit.com` fails the build.
const here = fileURLToPath(new URL(".", import.meta.url));
const packagesDir = resolve(here, "../..");
const SCANNED_SOURCE_DIRS = ["qbo-client/src", "server/src", "cli/src"];
const PRODUCTION_HOST = /(?<!sandbox-)quickbooks\.api\.intuit\.com/;

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

describe("sandbox-only hosts", () => {
  it("names only the sandbox QuickBooks API host anywhere in the code", () => {
    const offenders = [];
    let scanned = 0;
    for (const dir of SCANNED_SOURCE_DIRS) {
      for (const file of walk(join(packagesDir, dir))) {
        scanned += 1;
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (PRODUCTION_HOST.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(scanned).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });

  it("would catch the production host if it were introduced", () => {
    expect(PRODUCTION_HOST.test("https://quickbooks.api.intuit.com/v3")).toBe(true);
    expect(PRODUCTION_HOST.test("https://sandbox-quickbooks.api.intuit.com/v3")).toBe(false);
  });
});

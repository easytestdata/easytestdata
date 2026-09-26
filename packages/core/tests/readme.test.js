import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");

const repoRoot = path.resolve(packageRoot, "../..");

// Each README's first ```js block must run against the local source, so docs can't rot.
const readmes = [
  { name: "packages/core/README.md", file: path.join(packageRoot, "README.md") },
  // The root README also promises the exact output in a trailing comment.
  { name: "README.md", file: path.join(repoRoot, "README.md"), expect: "Nguyen Media 1080" }
];

describe.each(readmes)("$name quick start", ({ file, expect: expected }) => {
  it("runs the first ```js block against the local source", () => {
    const readme = fs.readFileSync(file, "utf8");
    const match = /```js\n([\s\S]*?)```/.exec(readme);
    expect(match, "README must contain a ```js code block").not.toBeNull();

    const localEntry = pathToFileURL(path.join(packageRoot, "src/index.js")).href;
    const code = match[1].replace(/(["'])@easytestdata\/core\1/g, JSON.stringify(localEntry));
    expect(code).toContain(localEntry);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "etd-readme-"));
    const snippet = path.join(dir, "snippet.mjs");
    fs.writeFileSync(snippet, code, "utf8");
    try {
      const stdout = execFileSync(process.execPath, [snippet], {
        encoding: "utf8",
        // Plain output regardless of the caller's terminal (FORCE_COLOR would colour numbers).
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }
      });
      expect(stdout.trim().length).toBeGreaterThan(0);
      if (expected) expect(stdout.trim()).toBe(expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

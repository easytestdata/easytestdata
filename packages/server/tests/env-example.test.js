import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const IGNORED = new Set(["NODE_ENV", "CI", "VITEST", "LOG_PRETTY", "LOCAL_PUBLIC_URL"]);

it(".env.example lists exactly the environment variables the code reads", () => {
  const example = [
    ...readFileSync(new URL(".env.example", root), "utf8").matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)
  ].map((m) => m[1]);
  const code =
    execSync(
      "grep -rhoE 'process\\.env\\.[A-Z][A-Z0-9_]+' packages/server/src packages/cli/src packages/marketing/build.js || true",
      { cwd: root }
    )
      .toString()
      .match(/[A-Z][A-Z0-9_]+$/gm) ?? [];
  const read = [...new Set(code)].filter((v) => !IGNORED.has(v)).sort();
  expect([...new Set(example)].sort()).toEqual(read);
});

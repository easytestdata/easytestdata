import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/check-migration-sequence.mjs", import.meta.url)
);
const dir = mkdtempSync(join(tmpdir(), "eztd-migration-sequence-"));

function fixture(files) {
  const path = mkdtempSync(join(dir, "migrations-"));
  for (const file of files) writeFileSync(join(path, file), "SELECT 1;");
  return path;
}

function check(dirs = []) {
  return spawnSync(process.execPath, [script, ...dirs], { cwd: dir, encoding: "utf8" });
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("migration sequence CLI", () => {
  it("accepts two directories, resolves relative args from cwd and checks each separately", () => {
    const first = fixture(["001_first.sql", "002_next.sql", "README.md"]);
    const second = fixture(["001_widgets.sql"]);
    const result = check([first.slice(dir.length + 1), second]);
    expect(result.status).toBe(0);
    expect(result.stdout.match(/Sequence check passed/g)).toHaveLength(2);
  });

  it.each([
    ["invalid second directory", ["001_Widgets.sql"], /Invalid migration filename/],
    ["duplicate prefix", ["001_first.sql", "001_other.sql"], /Duplicate migration prefix 001/],
    ["gap", ["001_first.sql", "003_other.sql"], /Non-contiguous.*002/]
  ])("rejects %s and accepts its corrected companion", (_label, files, error) => {
    const valid = fixture(["001_first.sql", "002_next.sql"]);
    const result = check([valid, fixture(files)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(error);
    expect(check([valid, fixture(["001_widgets.sql", "002_other.sql"])]).status).toBe(0);
  });

  it("rejects a missing directory and accepts an empty one", () => {
    expect(check([join(dir, "missing")]).status).toBe(1);
    const empty = join(dir, "empty");
    mkdirSync(empty);
    expect(check([empty]).status).toBe(0);
  });

  it("defaults to the core directory even when cwd is elsewhere", () => {
    const result = check();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Sequence check passed");
  });
});

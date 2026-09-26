import { describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/easytestdata.js");

function cli(args, options = {}) {
  const cwd = options.cwd || fs.mkdtempSync(path.join(os.tmpdir(), "etd-cli-"));
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", QBO_REFRESH_TOKEN: "", QBO_REALM_ID: "" }
  });
  return { ...result, cwd };
}

const FIXED = ["--seed", "1", "--start-date", "2025-01-01", "--months", "12"];

// Every case spawns the CLI (several times), which is slow while the whole monorepo's tests run
// in parallel: allow 20 s instead of vitest's 5 s.
describe("cli end to end", { timeout: 20_000 }, () => {
  it("prints help and exits 0 with no arguments", () => {
    const { status, stdout } = cli([]);
    expect(status).toBe(0);
    expect(stdout).toContain("Usage: easytestdata");
    expect(stdout).toContain("realistic test data for QuickBooks Online sandboxes");
    expect(stdout).toContain("generate");
  });

  it("streams JSON to a pipe and prints the summary on stderr", () => {
    const { status, stdout, stderr } = cli(["generate", ...FIXED]);
    expect(status).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.meta.startDate).toBe("2025-01-01");
    expect(plan.meta.endDate).toBe("2025-12-31");
    expect(stderr).toMatch(/Target profit/);
  });

  it("is byte-identical for the same seed and dates, and scenarios change the output", () => {
    const a = cli(["generate", ...FIXED, "-p", "rapid-growth"]).stdout;
    const b = cli(["generate", ...FIXED, "-p", "rapid-growth"]).stdout;
    const none = cli(["generate", ...FIXED]).stdout;
    expect(a).toBe(b);
    expect(a).not.toBe(none);
  });

  it("accepts --scenario and --profit and lists them in the help", () => {
    const documented = cli(["generate", ...FIXED, "--scenario", "cash-crisis", "--profit", "-25k"]);
    expect(documented.status).toBe(0);
    expect(JSON.parse(documented.stdout).metrics.targetEbitda).toBe(-25000);
    expect(documented.stderr).toContain("cash-crisis scenario · seed 1");
    const help = cli(["generate", "--help"]).stdout;
    expect(help).toContain("--scenario <id>");
    expect(help).toContain("--profit <amount>");
  });

  it("draws a seed for a seedless run, prints it, and reproduces the run with it", () => {
    const first = cli(["generate", "--start-date", "2025-01-01", "-p", "quick-demo"]);
    expect(first.status).toBe(0);
    const seed = JSON.parse(first.stdout).meta.seed;
    expect(Number.isInteger(seed)).toBe(true);
    expect(first.stderr).toContain(`seed ${seed}`);
    expect(first.stderr).toContain(
      `Re-run with --seed ${seed} --start-date 2025-01-01 to get the same data.`
    );
    expect(first.stderr).not.toContain("random seed");
    const again = cli([
      "generate",
      "--start-date",
      "2025-01-01",
      "-p",
      "quick-demo",
      "--seed",
      String(seed)
    ]);
    expect(again.stdout).toBe(first.stdout);
    expect(again.stderr).not.toContain("Re-run with");
  });

  it("writes one CSV per entity type with no comment preamble", () => {
    const { status, stdout, cwd } = cli([
      "generate",
      "--template",
      "saas",
      "--scenario",
      "rapid-growth",
      "--seed",
      "42",
      "--format",
      "csv",
      "--output",
      "./sample-data"
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain("Wrote 22 CSV files to ./sample-data/");
    expect(stdout).toMatch(/Customers\s+90/);
    const files = fs.readdirSync(path.join(cwd, "sample-data"));
    expect(files).toContain("invoice_lines.csv");
    expect(files).toContain("bill_lines.csv");
    for (const file of files) {
      const first = fs.readFileSync(path.join(cwd, "sample-data", file), "utf8").split("\r\n")[0];
      expect(first.startsWith("#")).toBe(false);
    }
  });

  it("accepts human amounts, including negative EBITDA", () => {
    const { status, stdout } = cli([
      "plan",
      ...FIXED,
      "--revenue",
      "1.5M",
      "--profit",
      "-50k",
      "--json"
    ]);
    expect(status).toBe(0);
    const { metrics } = JSON.parse(stdout);
    expect(metrics.totalRevenueRequested).toBe(1500000);
    expect(metrics.targetEbitda).toBe(-50000);
  });

  it("rejects unknown templates and scenarios with exit 1 and the valid names", () => {
    const t = cli(["generate", "--template", "bakery"]);
    expect(t.status).toBe(1);
    expect(t.stderr).toContain('Unknown industry template "bakery"');
    expect(t.stderr).toContain("real-estate");
    const p = cli(["plan", "--scenario", "boom"]);
    expect(p.status).toBe(1);
    expect(p.stderr).toContain('Unknown scenario "boom". Valid scenarios: healthy-small');
  });

  it("gives one-line errors for bad flag values", () => {
    const r = cli(["plan", "--revenue", "lots"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Expected an amount");
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it("load --dry-run prints the summary without a connection", () => {
    const r = cli(["load", "--dry-run", ...FIXED, "-p", "new-company"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Customers\s+10/);
    expect(r.stdout).toContain("Dry run");
  });

  it("load/purge without a connection point at auth", () => {
    for (const args of [["load"], ["purge", "-y"]]) {
      const r = cli(args);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("easytestdata auth");
    }
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// A stand-in for ora that records every spinner, so a test can tell whether update() reached a
// running one or set the text of a spinner that warn() or info() had already stopped.
const spinners = [];
vi.mock("ora", () => ({
  default: (options = {}) => {
    const spinner = {
      text: options.text ?? "",
      running: false,
      start() {
        this.running = true;
        return this;
      },
      stop() {
        this.running = false;
      },
      succeed() {
        this.running = false;
      },
      fail() {
        this.running = false;
      },
      warn() {
        this.running = false;
      },
      info() {
        this.running = false;
      }
    };
    spinners.push(spinner);
    return spinner;
  }
}));

const { createProgressRenderer } = await import("../src/progress.js");

function runningSpinners() {
  return spinners.filter((spinner) => spinner.running);
}

describe("createProgressRenderer", () => {
  beforeEach(() => {
    spinners.length = 0;
  });

  it("keeps the progress line moving after a rate-limit warning", () => {
    const progress = createProgressRenderer();
    progress.start("Loading");
    progress.update({ step: 1, totalSteps: 11, message: "Creating customers" });

    progress.warn("QuickBooks rate limit reached; waiting 30s");

    const [current] = runningSpinners();
    expect(current).toBeDefined();
    expect(current.text).toContain("Creating customers");

    progress.update({ step: 2, totalSteps: 11, message: "Creating vendors" });
    expect(runningSpinners()).toEqual([current]);
    expect(current.text).toContain("[2/11]");
    expect(current.text).toContain("Creating vendors");
  });

  it("keeps the progress line moving after an info line", () => {
    const progress = createProgressRenderer();
    progress.start("Removing test data");
    progress.update({ step: 1, totalSteps: 4, message: "Deleting invoices" });

    progress.info("Skipped 2 records already deleted");

    const [current] = runningSpinners();
    expect(current.text).toContain("Deleting invoices");
    progress.update({ step: 2, totalSteps: 4, message: "Deleting bills" });
    expect(current.text).toContain("Deleting bills");
  });

  it("leaves no spinner running once the operation succeeds after a warning", () => {
    const progress = createProgressRenderer();
    progress.start("Loading");
    progress.warn("QuickBooks rate limit reached; waiting 30s");
    progress.succeed("Loaded");

    expect(runningSpinners()).toEqual([]);
  });

  it("prints a warning without a spinner when none is running", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const progress = createProgressRenderer();

    progress.warn("No spinner yet");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("No spinner yet"));
    expect(spinners).toEqual([]);
    warn.mockRestore();
  });
});

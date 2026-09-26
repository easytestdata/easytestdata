import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InlineJobProgress,
  JobDownloadButtons,
  getJobDownloadFormats,
  type Job
} from "@easytestdata/ui";

const apiMocks = vi.hoisted(() => ({
  downloadJob: vi.fn()
}));

vi.mock("@easytestdata/shared/api-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  downloadJob: (...args: unknown[]) => apiMocks.downloadJob(...args)
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    type: "generate",
    status: "completed",
    config: {},
    progress: null,
    result: null,
    error: null,
    entity_count: 120,
    created_at: "2026-09-01T00:00:00.000Z",
    started_at: "2026-09-01T00:00:00.000Z",
    completed_at: "2026-09-01T00:00:10.000Z",
    result_summary: {
      artifact: { filename: "job-1.json", format: "json" },
      artifacts: {
        json: { filename: "job-1.json", format: "json" },
        csv: { filename: "job-1-csv.zip", format: "csv" }
      }
    },
    ...overrides
  };
}

describe("job downloads", () => {
  beforeEach(() => {
    apiMocks.downloadJob.mockReset();
    apiMocks.downloadJob.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("offers JSON and CSV for completed generate jobs", () => {
    expect(getJobDownloadFormats(makeJob())).toEqual(["json", "csv"]);
    expect(getJobDownloadFormats(makeJob({ type: "export" }))).toEqual(["json", "csv"]);
  });

  it("offers nothing for load jobs or unfinished jobs", () => {
    expect(getJobDownloadFormats(makeJob({ type: "load" }))).toEqual([]);
    expect(getJobDownloadFormats(makeJob({ status: "running" }))).toEqual([]);
    expect(getJobDownloadFormats(null)).toEqual([]);
  });

  it("downloads the chosen format through the artifact endpoint", async () => {
    render(<JobDownloadButtons job={makeJob()} />);

    fireEvent.click(screen.getByRole("button", { name: "Download CSV (zip)" }));
    await waitFor(() => expect(apiMocks.downloadJob).toHaveBeenCalledWith("job-1", "csv"));

    fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
    await waitFor(() => expect(apiMocks.downloadJob).toHaveBeenCalledWith("job-1", "json"));
  });

  it("shows download buttons when a generate job finishes in the wizard", () => {
    render(<InlineJobProgress job={makeJob()} onCancelJob={vi.fn()} />);

    expect(screen.getByText("Your sample files are ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download JSON" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download CSV (zip)" })).toBeInTheDocument();
    expect(screen.queryByText("Your company is loaded")).not.toBeInTheDocument();
  });

  it("points a finished load at the sandbox and where to look first", () => {
    render(
      <InlineJobProgress
        job={makeJob({
          type: "load",
          result_summary: null,
          config: { startDate: "2025-09-01", endDate: "2026-08-31" }
        })}
        connectionName="Sandbox Co"
        onCancelJob={vi.fn()}
      />
    );

    expect(screen.getByText("Your company is loaded")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open your sandbox in QuickBooks" })).toHaveAttribute(
      "href",
      "https://app.sandbox.qbo.intuit.com/app/homepage"
    );
    expect(screen.getByText(/switch to/)).toHaveTextContent("Sandbox Co");
    expect(screen.getByText(/Sales > Invoices/)).toBeInTheDocument();
    expect(screen.getByText(/Expenses > Bills/)).toBeInTheDocument();
    expect(
      screen.getByText("Reports > Profit and Loss for Sep 2025 - Aug 2026")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
  });
});

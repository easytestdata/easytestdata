import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InlineJobProgress, type Job } from "@easytestdata/ui";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function purgeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-purge",
    type: "purge",
    status: "completed",
    config: { purgeMode: "generated", tag: "EZTD" },
    progress: null,
    result: null,
    error: null,
    entity_count: 42,
    created_at: "2026-09-01T00:00:00.000Z",
    started_at: "2026-09-01T00:00:00.000Z",
    completed_at: "2026-09-01T00:00:10.000Z",
    result_summary: { deletedTotal: 42 },
    ...overrides
  } as Job;
}

// A remove or erase used to fall through to the load view: "Your company is loaded",
// "42 records created" (42 was the number deleted) and a "Load more data" button.
describe("InlineJobProgress for Remove test data and Erase all data", () => {
  afterEach(cleanup);

  it("says what a finished Remove test data deleted, not that a company was loaded", () => {
    render(
      <InlineJobProgress job={purgeJob()} connectionName="Acme Books" onCancelJob={vi.fn()} />
    );

    expect(screen.getByText("Test data removed")).toBeInTheDocument();
    expect(
      screen.getByText(/42 EasyTestData transaction\(s\) were deleted from Acme Books/)
    ).toHaveTextContent("accounts stay");
    expect(screen.queryByText("Your company is loaded")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more data" })).not.toBeInTheDocument();
  });

  it("names a finished Erase all data as an erase", () => {
    render(
      <InlineJobProgress
        job={purgeJob({ config: { purgeMode: "all" } })}
        connectionName="Acme Books"
        onCancelJob={vi.fn()}
      />
    );
    expect(screen.getByText("Sandbox data erased")).toBeInTheDocument();
  });

  it("says what a running remove is doing", () => {
    render(
      <InlineJobProgress
        job={purgeJob({ status: "running" })}
        connectionName="Acme Books"
        onCancelJob={vi.fn()}
      />
    );
    expect(screen.getByText("Removing test data from Acme Books")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
  });
});

// Purge jobs complete even when QuickBooks refused some deletes (result_summary.failureCount).
describe("InlineJobProgress for a remove with failures", () => {
  afterEach(cleanup);

  it("says it only partly worked instead of showing success", () => {
    render(
      <InlineJobProgress
        job={purgeJob({ result_summary: { deletedTotal: 40, failureCount: 2 } })}
        connectionName="Acme Books"
        onCancelJob={vi.fn()}
      />
    );
    expect(screen.getByText("Test data partly removed")).toBeInTheDocument();
    expect(screen.getByText(/2 operation\(s\) failed, so some records remain/)).toBeInTheDocument();
    expect(screen.queryByText("Test data removed")).not.toBeInTheDocument();
  });
});

// A load completes even when QuickBooks refused some records; the card used to say it all loaded.
describe("InlineJobProgress for a load with refused records", () => {
  afterEach(cleanup);

  it("says the company is only partly loaded and offers the details", () => {
    const onViewDetails = vi.fn();
    render(
      <InlineJobProgress
        job={purgeJob({ type: "load", config: {}, result_summary: { failureCount: 3 } })}
        connectionName="Acme Books"
        onCancelJob={vi.fn()}
        onViewDetails={onViewDetails}
      />
    );
    expect(screen.getByText("Your company is partly loaded")).toBeInTheDocument();
    expect(screen.getByText(/QuickBooks refused 3 record\(s\); everything else was created in Acme Books/)).toBeInTheDocument();
    expect(screen.queryByText("Your company is loaded")).not.toBeInTheDocument();
    screen.getByRole("button", { name: "View details" }).click();
    expect(onViewDetails).toHaveBeenCalled();
  });
});

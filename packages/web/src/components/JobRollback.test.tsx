import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InlineJobProgress, JobDetailSheet, JobProgressModal, type Job } from "@easytestdata/ui";

const api = vi.hoisted(() => ({ rollbackJob: vi.fn(), cancelJob: vi.fn() }));
vi.mock("@easytestdata/shared/api-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  rollbackJob: (...args: unknown[]) => api.rollbackJob(...args),
  cancelJob: (...args: unknown[]) => api.cancelJob(...args)
}));

vi.mock("@easytestdata/shared/api-hooks", () => ({
  useJob: () => ({ data: undefined }),
  useJobData: () => ({ data: undefined, isLoading: false, error: null }),
  useCreateJob: () => ({ mutateAsync: vi.fn(), isPending: false })
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

// jsdom has no layout; the progress log scrolls its last line into view.
Element.prototype.scrollIntoView = vi.fn();

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "load-1",
    type: "load",
    status: "failed_with_orphans",
    connection_id: "conn-1",
    config: { templateId: "saas" },
    progress: { step: 9, totalSteps: 11, message: "Creating refund receipts... 1 of 1" },
    result: null,
    error: "Cancelled after 61 record(s) were created in QuickBooks. Roll back to remove them.",
    entity_count: null,
    created_at: "2026-09-26T00:00:00.000Z",
    started_at: "2026-09-26T00:00:00.000Z",
    completed_at: "2026-09-26T00:00:16.000Z",
    result_summary: null,
    ...overrides
  };
}

const rollback = makeJob({
  id: "rollback-1",
  type: "rollback",
  status: "pending",
  progress: null,
  error: null,
  completed_at: null
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("rolling back a stopped load", () => {
  it("starts the roll back from the job's details once and hands the new job to the page", async () => {
    let resolve!: (job: Job) => void;
    api.rollbackJob.mockReturnValue(new Promise<Job>((r) => (resolve = r)));
    const onJobStarted = vi.fn();
    const onJobUpdate = vi.fn();
    render(
      <JobDetailSheet
        open
        onOpenChange={() => {}}
        job={makeJob()}
        onJobUpdate={onJobUpdate}
        onJobStarted={onJobStarted}
      />
    );

    const button = screen.getByRole("button", { name: "Roll back" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.rollbackJob).toHaveBeenCalledTimes(1);
    expect(api.rollbackJob).toHaveBeenCalledWith("load-1");
    expect(screen.getByRole("button", { name: "Starting..." })).toBeDisabled();

    resolve(rollback);
    await waitFor(() => expect(onJobStarted).toHaveBeenCalledWith(rollback));
    expect(onJobUpdate).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Rolling back the records this load created...");
  });

  it("shows why the server refused a roll back and refreshes the job instead of failing silently", async () => {
    api.rollbackJob.mockRejectedValue(new Error("This load has already been rolled back."));
    const onJobStarted = vi.fn();
    const onJobUpdate = vi.fn();
    render(
      <JobDetailSheet
        open
        onOpenChange={() => {}}
        job={makeJob()}
        onJobUpdate={onJobUpdate}
        onJobStarted={onJobStarted}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("This load has already been rolled back.")
    );
    expect(onJobUpdate).toHaveBeenCalled();
    expect(onJobStarted).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Roll back" })).toBeEnabled();
  });

  it("reports a refused roll back from the progress modal too", async () => {
    api.rollbackJob.mockRejectedValue(new Error("A rollback of this load is already running."));
    const onJobStarted = vi.fn();
    render(
      <JobProgressModal open onOpenChange={() => {}} job={makeJob()} onJobStarted={onJobStarted} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("A rollback of this load is already running.")
    );
    expect(onJobStarted).not.toHaveBeenCalled();
  });

  it("offers Roll back and View details on the stopped load's progress card", async () => {
    const onRollback = vi.fn(async () => {});
    const onViewDetails = vi.fn();
    const job = makeJob();
    render(
      <InlineJobProgress
        job={job}
        connectionName="Acme Books"
        onCancelJob={vi.fn()}
        onRollback={onRollback}
        onViewDetails={onViewDetails}
      />
    );

    expect(screen.queryByText(/from Recent activity/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(onViewDetails).toHaveBeenCalledWith(job);

    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    await waitFor(() => expect(onRollback).toHaveBeenCalledWith("load-1"));
  });

  it("points to Recent activity when the card has no roll back handler", () => {
    render(<InlineJobProgress job={makeJob()} onCancelJob={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Roll back" })).not.toBeInTheDocument();
    expect(screen.getByText(/from Recent activity/)).toBeInTheDocument();
  });

  it("describes a roll back as a roll back, not as a load", () => {
    const props = { connectionName: "Acme Books", onCancelJob: vi.fn() };
    const { rerender } = render(
      <InlineJobProgress job={{ ...rollback, status: "running" }} {...props} />
    );
    expect(screen.getByText("Rolling back the stopped load in Acme Books")).toBeInTheDocument();
    expect(screen.queryByText(/Loading your company/)).not.toBeInTheDocument();

    rerender(
      <InlineJobProgress
        job={{
          ...rollback,
          status: "completed",
          entity_count: 61,
          result_summary: {
            totalDeleted: 40,
            totalInactivated: 21,
            note: "Customers a later load uses were kept active."
          }
        }}
        {...props}
      />
    );
    expect(screen.getByText("Roll back finished")).toBeInTheDocument();
    // Deleted and made-inactive are told apart: QuickBooks cannot delete master data.
    expect(
      screen.getByText(
        "40 record(s) the stopped load created were deleted from Acme Books. 21 customer, vendor, employee or item record(s) were made inactive (QuickBooks cannot delete those, so they stay in the sandbox)."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Customers a later load uses were kept active.")).toBeInTheDocument();
    expect(screen.queryByText(/removed/)).not.toBeInTheDocument();
    expect(screen.queryByText("Your company is loaded")).not.toBeInTheDocument();
  });

  it("falls back to the rolled-back count when a roll back has no summary yet", () => {
    render(
      <InlineJobProgress
        job={{ ...rollback, status: "completed", entity_count: 61 }}
        connectionName="Acme Books"
        onCancelJob={vi.fn()}
      />
    );
    expect(
      screen.getByText("61 record(s) the stopped load created were rolled back in Acme Books.")
    ).toBeInTheDocument();
  });

  it("says so when cancelling a job fails", async () => {
    const onCancelJob = vi.fn(async () => {
      throw new Error("Job is not running");
    });
    render(
      <InlineJobProgress
        job={makeJob({ status: "running", error: null, completed_at: null })}
        onCancelJob={onCancelJob}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Job is not running"));
  });

  it("keeps the card's buttons above the progress and the log, so they stay put as it grows", () => {
    render(
      <InlineJobProgress
        job={makeJob()}
        onCancelJob={vi.fn()}
        onRollback={vi.fn(async () => {})}
        onViewDetails={vi.fn()}
      />
    );
    // The progress bar sits between the header and the log.
    const progress = screen.getByRole("progressbar");
    for (const name of ["View details", "Roll back", "Close"]) {
      const button = screen.getByRole("button", { name });
      expect(
        button.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    }
  });

  it("shows a rolled-back load in amber, saying its records are gone", () => {
    render(
      <InlineJobProgress
        job={makeJob({ status: "failed", rolled_back: true })}
        onCancelJob={vi.fn()}
        onRollback={vi.fn(async () => {})}
      />
    );

    expect(screen.getByText("Rolled back")).toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Cancelled after 61 record(s) were created in QuickBooks. They have been rolled back."
      )
    ).toHaveClass("text-amber-800");
    expect(screen.queryByRole("button", { name: "Roll back" })).not.toBeInTheDocument();
  });

  it("labels a rolled-back load in its details, and only when its rollback completed", () => {
    const { rerender } = render(
      <JobDetailSheet
        open
        onOpenChange={() => {}}
        job={makeJob({ status: "failed", rolled_back: true })}
      />
    );
    expect(screen.getByText("Rolled back")).toBeInTheDocument();

    rerender(<JobDetailSheet open onOpenChange={() => {}} job={makeJob({ status: "failed" })} />);
    expect(screen.queryByText("Rolled back")).not.toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });
});

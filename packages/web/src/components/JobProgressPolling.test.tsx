import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InlineJobProgress, JobProgressLog, JobProgressModal, type Job } from "@easytestdata/ui";

const getJob = vi.hoisted(() => vi.fn());
vi.mock("@easytestdata/shared/api-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getJob: (...args: unknown[]) => getJob(...args)
}));

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    type: "load",
    status: "running",
    config: {},
    progress: null,
    result: null,
    error: null,
    entity_count: null,
    created_at: "2026-09-01T00:00:00.000Z",
    started_at: "2026-09-01T00:00:00.000Z",
    completed_at: null,
    result_summary: null,
    ...overrides
  } as Job;
}

const progress = (step: number, message: string) => ({ step, totalSteps: 10, message });

// jsdom has no layout; the progress log scrolls its last line into view.
Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  cleanup();
  getJob.mockReset();
  vi.useRealTimers();
});

describe("job progress from the polled job", () => {
  it("InlineJobProgress shows each polled progress message and the failure", () => {
    const onJobUpdate = vi.fn();
    const props = { onCancelJob: vi.fn(), onJobUpdate };
    const { rerender } = render(
      <InlineJobProgress
        job={makeJob({ progress: progress(2, "Creating customers") })}
        {...props}
      />
    );
    expect(screen.getByText("2/10")).toBeInTheDocument();
    expect(screen.getAllByText("Creating customers").length).toBeGreaterThan(0);

    rerender(
      <InlineJobProgress job={makeJob({ progress: progress(5, "Creating invoices") })} {...props} />
    );
    expect(screen.getByText("5/10")).toBeInTheDocument();
    // The log keeps the earlier message and adds the new one.
    expect(screen.getAllByText("Creating customers").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Creating invoices").length).toBeGreaterThan(0);
    expect(onJobUpdate).not.toHaveBeenCalled();

    rerender(
      <InlineJobProgress
        job={makeJob({
          status: "failed",
          error: "boom",
          progress: progress(5, "Creating invoices")
        })}
        {...props}
      />
    );
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByText("Failed: boom")).toBeInTheDocument();
    expect(onJobUpdate).toHaveBeenCalledOnce();
  });

  it("InlineJobProgress shows the completed state once the polled job completes", () => {
    const props = { onCancelJob: vi.fn(), connectionName: "Sandbox Co" };
    const { rerender } = render(
      <InlineJobProgress job={makeJob({ progress: progress(9, "Creating bills") })} {...props} />
    );
    rerender(
      <InlineJobProgress
        job={makeJob({ status: "completed", entity_count: 120, progress: progress(10, "Done") })}
        {...props}
      />
    );
    expect(screen.getByText("Your company is loaded")).toBeInTheDocument();
    expect(screen.getByText(/120 records created in Sandbox Co/)).toBeInTheDocument();
  });

  it.each(["failed", "failed_with_orphans", "cancelled"] as const)(
    "InlineJobProgress lets a %s job close the card like the other terminal states",
    (status) => {
      const onLoadMore = vi.fn();
      render(
        <InlineJobProgress
          job={makeJob({ status, error: status === "cancelled" ? null : "boom" })}
          onCancelJob={vi.fn()}
          onLoadMore={onLoadMore}
        />
      );
      expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
      screen.getByRole("button", { name: "Close" }).click();
      expect(onLoadMore).toHaveBeenCalledOnce();
    }
  );

  it("InlineJobProgress keeps the Close button away while the job is still cancelling", () => {
    render(
      <InlineJobProgress
        job={makeJob({ status: "cancelling" })}
        onCancelJob={vi.fn()}
        onLoadMore={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("JobProgressLog summarizes a job that had already finished (no live log)", () => {
    render(
      <JobProgressLog
        job={makeJob({
          status: "completed",
          progress: progress(10, "Done"),
          completed_at: "2026-09-01T00:00:10.000Z"
        })}
      />
    );
    expect(screen.getByText("Job completed successfully")).toBeInTheDocument();
    expect(screen.getByText("10 steps completed")).toBeInTheDocument();
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
  });

  it("JobProgressModal polls the job while open and shows it finish", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const polled = [
      makeJob({ progress: progress(3, "Creating vendors") }),
      makeJob({ status: "cancelled", progress: progress(4, "Creating bills") })
    ];
    getJob.mockImplementation(async () => polled.shift() ?? makeJob({ status: "cancelled" }));
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <JobProgressModal
          open
          onOpenChange={() => {}}
          job={makeJob({ status: "pending", progress: null })}
        />
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getByText("3/10")).toBeInTheDocument());
    expect(screen.getAllByText("Creating vendors").length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() => expect(screen.getByText("Job cancelled")).toBeInTheDocument());
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(getJob).toHaveBeenCalledWith("job-1");
  });
});

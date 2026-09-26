import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobDetailSheet, StatusBadge, displayStatus, type Job } from "@easytestdata/ui";

vi.mock("@easytestdata/shared/api-hooks", () => ({
  useJob: () => ({ data: undefined }),
  useJobData: () => ({ data: undefined, isLoading: false, error: null }),
  useCreateJob: () => ({ mutateAsync: vi.fn(), isPending: false })
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const purge: Job = {
  id: "job-purge",
  type: "purge",
  status: "completed",
  connection_id: "conn-1",
  config: { purgeMode: "generated", tag: "EZTD", companyName: "Acme Books" },
  progress: null,
  result: null,
  error: null,
  entity_count: 40,
  created_at: "2026-09-01T00:00:00.000Z",
  started_at: "2026-09-01T00:00:00.000Z",
  completed_at: "2026-09-01T00:00:10.000Z",
  result_summary: { deletedTotal: 40, failureCount: 2 }
};

// A job that finished while QuickBooks refused some records used to read a plain green "Completed".
describe("Completed with errors", () => {
  afterEach(cleanup);

  it("shows an amber Completed with errors badge when QuickBooks refused records", () => {
    expect(displayStatus(purge)).toBe("completed_with_errors");
    expect(displayStatus({ ...purge, result_summary: { failureCount: 0 } })).toBe("completed");
    // A /jobs/:id detail response has the full result instead of result_summary: still amber.
    const detail = { ...purge, result_summary: null, result: { failures: [{}, {}] } };
    expect(displayStatus(detail)).toBe("completed_with_errors");
    expect(displayStatus({ ...detail, result: { failureCount: 1 } })).toBe("completed_with_errors");
    expect(displayStatus({ ...detail, result: { failures: [] } })).toBe("completed");
    render(<StatusBadge status={displayStatus(purge)} />);
    expect(screen.getByText("Completed with errors")).toBeInTheDocument();
  });

  it("explains what happened and where to see which records, in the job details", () => {
    render(<JobDetailSheet open onOpenChange={() => {}} job={purge} />);
    expect(
      screen.getByText("Completed with errors: QuickBooks refused 2 operation(s).")
    ).toBeInTheDocument();
    expect(screen.getByText(/The Failures tab lists each record with QuickBooks' reason/)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Failures" })).toBeInTheDocument();
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobDetailPage } from "./JobDetailPage";
import { JobManagementPage } from "./JobManagementPage";

const apiMocks = vi.hoisted(() => ({
  getAdminJob: vi.fn(),
  getAdminJobs: vi.fn(),
  getJobStats: vi.fn(),
  cancelAdminJob: vi.fn(),
  retryAdminJob: vi.fn(),
  forceFailJob: vi.fn()
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn()
}));

vi.mock("@/api/admin", () => ({
  getAdminJob: (...args: unknown[]) => apiMocks.getAdminJob(...args),
  getAdminJobs: (...args: unknown[]) => apiMocks.getAdminJobs(...args),
  getJobStats: (...args: unknown[]) => apiMocks.getJobStats(...args),
  cancelAdminJob: (...args: unknown[]) => apiMocks.cancelAdminJob(...args),
  retryAdminJob: (...args: unknown[]) => apiMocks.retryAdminJob(...args),
  forceFailJob: (...args: unknown[]) => apiMocks.forceFailJob(...args)
}));

vi.mock("sonner", () => ({
  toast: toastMocks
}));

const failedJob = {
  id: "job-1",
  type: "load",
  status: "failed",
  entity_count: 12,
  created_at: "2026-07-08T10:00:00.000Z",
  started_at: "2026-07-08T10:01:00.000Z",
  completed_at: "2026-07-08T10:02:00.000Z",
  error: "QBO rejected request",
  team_id: "team-1",
  team_name: "Team One",
  config: { industry: "saas" },
  progress: null,
  result: null
};

function renderWithClient(children: ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

describe("admin job actions", () => {
  beforeEach(() => {
    apiMocks.getAdminJob.mockReset();
    apiMocks.getAdminJobs.mockReset();
    apiMocks.getJobStats.mockReset();
    apiMocks.cancelAdminJob.mockReset();
    apiMocks.retryAdminJob.mockReset();
    apiMocks.forceFailJob.mockReset();
    toastMocks.success.mockReset();
    toastMocks.error.mockReset();
    apiMocks.getJobStats.mockResolvedValue({
      statusBreakdown: [],
      avgDuration: [],
      failureRate: []
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("locks the detail retry action while retry is pending", async () => {
    let resolveRetry!: (value: unknown) => void;
    let resolveJobRefetch!: (value: unknown) => void;
    apiMocks.getAdminJob.mockResolvedValueOnce(failedJob);
    apiMocks.getAdminJob.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveJobRefetch = resolve;
        })
    );
    apiMocks.retryAdminJob.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRetry = resolve;
        })
    );

    renderWithClient(
      <MemoryRouter initialEntries={["/admin/jobs/job-1"]}>
        <Routes>
          <Route path="/admin/jobs/:id" element={<JobDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    const retryButton = await screen.findByRole("button", { name: /retry/i });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(apiMocks.retryAdminJob).toHaveBeenCalled();
    });
    expect(apiMocks.retryAdminJob.mock.calls[0]?.[0]).toBe("job-1");
    expect(apiMocks.retryAdminJob).toHaveBeenCalledTimes(1);
    expect(retryButton).toBeDisabled();

    await act(async () => {
      resolveRetry({});
    });

    await waitFor(() => {
      expect(apiMocks.getAdminJob).toHaveBeenCalledTimes(2);
    });
    expect(retryButton).toBeDisabled();

    await act(async () => {
      resolveJobRefetch(failedJob);
    });

    await waitFor(() => {
      expect(toastMocks.success).toHaveBeenCalledWith("Retried");
    });
    await waitFor(() => {
      expect(retryButton).not.toBeDisabled();
    });
  });

  it("shows the server's force-fail message (the job may still be stopping)", async () => {
    const runningJob = { ...failedJob, status: "running", completed_at: null, error: null };
    apiMocks.getAdminJob.mockResolvedValue(runningJob);
    apiMocks.forceFailJob.mockResolvedValue({
      success: true,
      status: "running",
      message: "Stopping the job. It is marked failed once its work stops."
    });

    renderWithClient(
      <MemoryRouter initialEntries={["/admin/jobs/job-1"]}>
        <Routes>
          <Route path="/admin/jobs/:id" element={<JobDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole("button", { name: /force fail/i }));

    await waitFor(() => {
      expect(toastMocks.success).toHaveBeenCalledWith(
        "Stopping the job. It is marked failed once its work stops."
      );
    });
  });

  it("locks the table retry action while retry is pending", async () => {
    let resolveRetry!: (value: unknown) => void;
    let resolveJobsRefetch!: (value: unknown) => void;
    const jobsResponse = {
      jobs: [failedJob],
      total: 1,
      page: 1,
      limit: 50
    };
    apiMocks.getAdminJobs.mockResolvedValueOnce(jobsResponse);
    apiMocks.getAdminJobs.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveJobsRefetch = resolve;
        })
    );
    apiMocks.retryAdminJob.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRetry = resolve;
        })
    );

    renderWithClient(
      <MemoryRouter>
        <JobManagementPage />
      </MemoryRouter>
    );

    const retryButton = await screen.findByTitle("Retry");
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(apiMocks.retryAdminJob).toHaveBeenCalled();
    });
    expect(apiMocks.retryAdminJob.mock.calls[0]?.[0]).toBe("job-1");
    expect(apiMocks.retryAdminJob).toHaveBeenCalledTimes(1);
    expect(retryButton).toBeDisabled();

    await act(async () => {
      resolveRetry({});
    });

    await waitFor(() => {
      expect(apiMocks.getAdminJobs).toHaveBeenCalledTimes(2);
    });
    expect(retryButton).toBeDisabled();

    await act(async () => {
      resolveJobsRefetch(jobsResponse);
    });

    await waitFor(() => {
      expect(toastMocks.success).toHaveBeenCalledWith("Job retried");
    });
    await waitFor(() => {
      expect(retryButton).not.toBeDisabled();
    });
  });
});

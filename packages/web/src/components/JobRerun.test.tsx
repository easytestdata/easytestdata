import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobDetailSheet, loadAgainDescription, type Job } from "@easytestdata/ui";

const createJob = vi.hoisted(() => ({ mutateAsync: vi.fn(async () => ({})), isPending: false }));

vi.mock("@easytestdata/shared/api-hooks", () => ({
  useJob: () => ({ data: undefined }),
  useJobData: () => ({ data: undefined, isLoading: false, error: null }),
  useCreateJob: () => createJob
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const finishedLoad: Job = {
  id: "job-1",
  type: "load",
  status: "completed",
  connection_id: "conn-1",
  config: { templateId: "retail", presetId: "quick-demo", connectionId: "conn-1", seed: 42 },
  progress: null,
  result: null,
  error: null,
  entity_count: 120,
  created_at: "2026-09-01T00:00:00.000Z",
  started_at: "2026-09-01T00:00:00.000Z",
  completed_at: "2026-09-01T00:00:10.000Z",
  result_summary: null
};

describe("JobDetailSheet re-run", () => {
  afterEach(() => cleanup());

  it("starts a new job from the finished job's config with a fresh seed, after confirming", async () => {
    render(<JobDetailSheet open onOpenChange={() => {}} job={finishedLoad} />);

    fireEvent.click(screen.getByRole("button", { name: "Load again (new data)" }));
    // Nothing starts until the user has read what will happen.
    expect(createJob.mutateAsync).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog", { name: "Load again with new data?" });
    expect(dialog).toHaveTextContent("on top of what is already there");
    fireEvent.click(within(dialog).getByRole("button", { name: "Load again" }));

    await waitFor(() => expect(createJob.mutateAsync).toHaveBeenCalledTimes(1));
    expect(createJob.mutateAsync).toHaveBeenCalledWith({
      type: "load",
      connectionId: "conn-1",
      templateId: "retail",
      config: { templateId: "retail", presetId: "quick-demo", connectionId: "conn-1" }
    });
  });
});

describe("loadAgainDescription", () => {
  const withConfig = (config: Record<string, unknown>): Job => ({
    ...finishedLoad,
    config: { ...finishedLoad.config, ...config }
  });

  it("says a load without 'remove first' adds another company on top", () => {
    expect(loadAgainDescription(withConfig({}), "Acme Books")).toMatch(
      /about 120 records.*adds them to Acme Books on top of what is already there/
    );
  });

  it("says a load that removed test data first does so again", () => {
    expect(loadAgainDescription(withConfig({ purgeMode: "generated", tag: "EZTD" }), "Acme Books")).toMatch(
      /first removes the existing test data \(tagged EZTD\) from Acme Books/
    );
  });

  it("says a load that erased everything first does so again", () => {
    expect(loadAgainDescription(withConfig({ purgeMode: "all" }), "Acme Books")).toMatch(
      /first erases all data in Acme Books, as the original load did: every transaction of the types EasyTestData loads is deleted, including ones you entered by hand.*Accounts stay\./
    );
  });
});

// Job configs never carry the sandbox name; the page passes it from its connection list.
describe("Load again names the sandbox", () => {
  afterEach(() => cleanup());

  it("uses the connection name the page passes in", () => {
    render(
      <JobDetailSheet open onOpenChange={() => {}} job={finishedLoad} connectionName="Acme Books" />
    );
    fireEvent.click(screen.getByRole("button", { name: "Load again (new data)" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("adds them to Acme Books");
  });
});

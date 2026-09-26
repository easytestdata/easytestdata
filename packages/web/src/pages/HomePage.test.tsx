import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPeriod, formatDateRange } from "@easytestdata/ui";
import { HomePage, getResultOneLiner, connectionHasPreviousLoad } from "./HomePage";
import type { Job, QboConnection } from "@/api/client";
import { authorizeConnection } from "@/api/client";

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn()
}));

const hookState = vi.hoisted(() => ({
  connections: [
    {
      id: "conn-1",
      realm_id: "realm-1",
      company_name: "Acme Books",
      base_url: "https://sandbox-quickbooks.api.intuit.com",
      connected_at: "2026-07-01T00:00:00.000Z",
      last_used_at: null,
      tokenHealth: "ok" as "ok" | "warning" | "expired"
    }
  ],
  jobs: [] as Array<Record<string, unknown>>,
  health: { status: "ok" } as { status: string } | undefined,
  usage: undefined as
    | { deployment: string; limits: { loadsPerMonth: number }; usage: { loads: number } }
    | undefined,
  templates: [
    { id: "professional-services", name: "Professional Services", description: "Consulting" },
    { id: "retail", name: "Retail / eCommerce", description: "Shops" }
  ],
  presets: [
    { id: "healthy-small", name: "Healthy small business", description: "Steady" },
    { id: "quick-demo", name: "Quick demo (3 months, small)", description: "Tiny", months: 3 }
  ]
}));

const clientMocks = vi.hoisted(() => ({
  estimateJob: vi.fn()
}));

const mutationMocks = vi.hoisted(() => ({
  createJob: {
    mutateAsync: vi.fn(),
    isPending: false
  },
  deleteConnection: {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false
  },
  testConnection: {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false
  },
  purgeConnection: {
    mutate: vi.fn(),
    isPending: false
  }
}));

vi.mock("@/api/hooks", () => ({
  useConnections: () => ({ data: hookState.connections, isLoading: false }),
  useJobs: () => ({ data: hookState.jobs, isLoading: false }),
  useJobUsage: () => ({ data: hookState.usage }),
  useCreateJob: () => mutationMocks.createJob,
  useDeleteConnection: () => mutationMocks.deleteConnection,
  useTestConnection: () => mutationMocks.testConnection,
  useConnectionHealth: () => ({ data: hookState.health, isLoading: !hookState.health }),
  useExpiredConnectionIds: (ids: string[]) =>
    new Set(hookState.health?.status === "expired" ? ids : []),
  usePurgeConnection: () => mutationMocks.purgeConnection,
  useIndustryTemplates: () => ({ data: hookState.templates, isLoading: false }),
  useScenarioPresets: () => ({ data: hookState.presets, isLoading: false })
}));

vi.mock("@/api/client", () => ({
  getScenarioPreset: vi.fn().mockResolvedValue({
    id: "healthy-small",
    name: "Healthy small business",
    description: "Steady",
    request: { totalRevenue: 500000, customerCount: 20, employeeCount: 5 },
    ratioOverrides: {}
  }),
  authorizeConnection: vi.fn(),
  cancelJob: vi.fn(),
  estimateJob: (...args: unknown[]) => clientMocks.estimateJob(...args)
}));

vi.mock("sonner", () => ({
  toast: toastMocks
}));

const sharedApi = vi.hoisted(() => ({ rollbackJob: vi.fn() }));
vi.mock("@easytestdata/shared/api-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  rollbackJob: (...args: unknown[]) => sharedApi.rollbackJob(...args)
}));

const appConfig = vi.hoisted(() => ({
  deployment: "cloud" as "cloud" | "local",
  qboConfigured: true,
  qboRedirectUri: "http://localhost:28080/api/v1/connections/callback"
}));

vi.mock("@/contexts/AppConfigContext", () => ({
  useAppConfig: () => appConfig
}));

beforeEach(() => {
  appConfig.deployment = "cloud";
  appConfig.qboConfigured = true;
  hookState.health = { status: "ok" };
  hookState.usage = undefined;
});

function renderWithClient(children: ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

function buildJob(id: string, type: "generate" | "load") {
  return {
    id,
    type,
    status: "pending",
    config: {},
    progress: null,
    result: null,
    error: null,
    entity_count: null,
    created_at: "2026-07-01T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    result_summary: null
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function completedLoad(id: string, connectionId: string) {
  return {
    ...buildJob(id, "load"),
    status: "completed",
    config: { connectionId, templateId: "retail" },
    entity_count: 800
  };
}

describe("HomePage actions", () => {
  beforeEach(() => {
    hookState.connections = [
      {
        id: "conn-1",
        realm_id: "realm-1",
        company_name: "Acme Books",
        base_url: "https://sandbox-quickbooks.api.intuit.com",
        connected_at: "2026-07-01T00:00:00.000Z",
        last_used_at: null,
        tokenHealth: "ok"
      }
    ];
    hookState.jobs = [];
    clientMocks.estimateJob.mockReset();
    clientMocks.estimateJob.mockResolvedValue({
      estimatedEntities: 802,
      metrics: { customerCount: 20, invoiceCount: 240, billCount: 48, paymentCount: 176 },
      limit: -1
    });
    mutationMocks.createJob.mutateAsync.mockReset();
    mutationMocks.createJob.mutateAsync.mockResolvedValue(buildJob("job-1", "load"));
    mutationMocks.deleteConnection.mutate.mockReset();
    mutationMocks.deleteConnection.mutateAsync.mockReset();
    mutationMocks.deleteConnection.isPending = false;
    mutationMocks.testConnection.mutate.mockReset();
    mutationMocks.testConnection.mutateAsync.mockReset();
    mutationMocks.testConnection.isPending = false;
    mutationMocks.purgeConnection.mutate.mockReset();
    mutationMocks.purgeConnection.isPending = false;
    toastMocks.success.mockReset();
    toastMocks.error.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("locks connection test controls against duplicate clicks until the test settles", () => {
    renderWithClient(<HomePage />);

    const testButton = screen.getByRole("button", { name: "Test Acme Books" });
    fireEvent.click(testButton);
    fireEvent.click(testButton);

    expect(mutationMocks.testConnection.mutate).toHaveBeenCalledTimes(1);
    expect(mutationMocks.testConnection.mutate).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({ onSettled: expect.any(Function) })
    );
    expect(testButton).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Remove test data from Acme Books" })
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Erase all data in Acme Books" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disconnect Acme Books" })).toBeDisabled();

    const testOptions = mutationMocks.testConnection.mutate.mock.calls[0]?.[1] as {
      onSettled: () => void;
    };
    act(() => testOptions.onSettled());

    expect(testButton).toBeEnabled();
    expect(screen.getByRole("button", { name: "Disconnect Acme Books" })).toBeEnabled();
  });

  it("locks disconnect confirmation against duplicate submits until deletion settles", () => {
    renderWithClient(<HomePage />);

    const disconnectButton = screen.getByRole("button", { name: "Disconnect Acme Books" });
    fireEvent.click(disconnectButton);

    const dialog = screen.getByRole("alertdialog", { name: "Disconnect Acme Books?" });
    const confirmButton = within(dialog).getByRole("button", { name: "Disconnect" });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    expect(mutationMocks.deleteConnection.mutate).toHaveBeenCalledTimes(1);
    expect(mutationMocks.deleteConnection.mutate).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({ onSettled: expect.any(Function) })
    );
    expect(disconnectButton).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Disconnecting..." })).toBeDisabled();

    const deleteOptions = mutationMocks.deleteConnection.mutate.mock.calls[0]?.[1] as {
      onSettled: () => void;
    };
    act(() => deleteOptions.onSettled());

    expect(disconnectButton).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Disconnect" })).toBeEnabled();
  });

  it("locks generated-data purge confirmation against duplicate submits until purge settles", () => {
    renderWithClient(<HomePage />);

    const clearButton = screen.getByRole("button", {
      name: "Remove test data from Acme Books"
    });
    fireEvent.click(clearButton);

    const dialog = screen.getByRole("alertdialog", { name: "Remove test data?" });
    // Purge never deletes accounts; the dialog must not promise a clean sandbox.
    expect(dialog).toHaveTextContent("Accounts it created stay.");
    const confirmButton = within(dialog).getByRole("button", { name: "Remove test data" });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    expect(mutationMocks.purgeConnection.mutate).toHaveBeenCalledTimes(1);
    expect(mutationMocks.purgeConnection.mutate).toHaveBeenCalledWith(
      { id: "conn-1" },
      expect.objectContaining({ onSettled: expect.any(Function) })
    );
    expect(clearButton).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Starting..." })).toBeDisabled();

    const purgeOptions = mutationMocks.purgeConnection.mutate.mock.calls[0]?.[1] as {
      onSettled: () => void;
    };
    act(() => purgeOptions.onSettled());

    expect(clearButton).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Remove test data" })).toBeEnabled();
  });

  it("locks all-data erase confirmation against duplicate submits until purge settles", () => {
    renderWithClient(<HomePage />);

    const eraseButton = screen.getByRole("button", { name: "Erase all data in Acme Books" });
    fireEvent.click(eraseButton);

    const dialog = screen.getByRole("alertdialog", { name: "Erase all data?" });
    fireEvent.change(within(dialog).getByPlaceholderText('Type "ERASE" to confirm'), {
      target: { value: "ERASE" }
    });
    const confirmButton = within(dialog).getByRole("button", { name: "Erase all data" });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    expect(mutationMocks.purgeConnection.mutate).toHaveBeenCalledTimes(1);
    expect(mutationMocks.purgeConnection.mutate).toHaveBeenCalledWith(
      { id: "conn-1", mode: "all" },
      expect.objectContaining({ onSettled: expect.any(Function) })
    );
    expect(eraseButton).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Starting..." })).toBeDisabled();

    const purgeOptions = mutationMocks.purgeConnection.mutate.mock.calls[0]?.[1] as {
      onSettled: () => void;
    };
    act(() => purgeOptions.onSettled());

    expect(eraseButton).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Erase all data" })).toBeEnabled();
  });

  it("shows the one-screen load with Professional Services and the healthy scenario preselected", async () => {
    renderWithClient(<HomePage />);

    expect(screen.getByRole("button", { name: "Professional Services" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByText("Healthy small business")).toBeInTheDocument();
    await screen.findByText("~802 records");
    // The button waits for a fresh estimate, which can settle a render after the text appears.
    await waitFor(
      () => expect(screen.getByRole("button", { name: /Load into QuickBooks/ })).toBeEnabled(),
      { timeout: 3000 }
    );
    expect(screen.getByText("~802 records")).toBeInTheDocument();
    // Scenario, dates, size and ratios are behind Customize, not a required step.
    expect(screen.queryByRole("button", { name: /Skip/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Quick demo (3 months, small)")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Customize/ }));
    expect(screen.getByText("Quick demo (3 months, small)")).toBeInTheDocument();
    expect(screen.getByLabelText("Start date")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Advanced Settings/ })).toBeInTheDocument();
    // No purge-mode radio anywhere in the load flow.
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("summarises what the load will create and how long it takes", async () => {
    renderWithClient(<HomePage />);

    expect(await screen.findByText("~802 records")).toBeInTheDocument();
    expect(
      screen.getByText(/20 customers, 240 invoices, 48 bills, 176 payments/)
    ).toBeInTheDocument();
    expect(screen.getByText("about 3 minutes at QuickBooks' rate limit")).toBeInTheDocument();
    expect(clientMocks.estimateJob).toHaveBeenCalledWith({
      templateId: "professional-services",
      config: expect.objectContaining({
        templateId: "professional-services",
        presetId: "healthy-small"
      })
    });
  });

  it("offers to clear the previous EasyTestData data only when this sandbox already has a load", async () => {
    hookState.jobs = [completedLoad("job-old", "conn-1")];
    renderWithClient(<HomePage />);

    const checkbox = screen.getByRole("checkbox", {
      name: "Remove existing test data (tagged EZTD) first"
    });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    await screen.findByText("~802 records");
    fireEvent.click(screen.getByRole("button", { name: /Load into QuickBooks/ }));

    expect(mutationMocks.createJob.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.objectContaining({ purgeMode: "generated" }) })
    );
  });

  it("offers to clear previous data from the server's per-sandbox flag (load not in the job list)", async () => {
    // The earlier load is older than the jobs the list returns; the connection row still knows.
    hookState.connections = [
      { ...hookState.connections[0], has_prior_load: true } as (typeof hookState.connections)[0]
    ];
    hookState.jobs = [];
    renderWithClient(<HomePage />);

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Remove existing test data (tagged EZTD) first" })
    );
    await screen.findByText("~802 records");
    fireEvent.click(screen.getByRole("button", { name: /Load into QuickBooks/ }));

    expect(mutationMocks.createJob.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.objectContaining({ purgeMode: "generated" }) })
    );
  });

  it("keeps existing data by default and never offers Erase ALL in the load flow", async () => {
    renderWithClient(<HomePage />);

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await screen.findByText("~802 records");
    fireEvent.click(screen.getByRole("button", { name: /Load into QuickBooks/ }));

    const body = mutationMocks.createJob.mutateAsync.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      type: "load",
      connectionId: "conn-1",
      templateId: "professional-services"
    });
    expect(body.config).not.toHaveProperty("purgeMode");
    expect(body.config).not.toHaveProperty("connectionId");
    expect(body.config).toMatchObject({
      templateId: "professional-services",
      presetId: "healthy-small",
      ...defaultPeriod()
    });
  });

  it("locks load job launches against duplicate clicks until job creation settles", async () => {
    const created = deferred<ReturnType<typeof buildJob>>();
    mutationMocks.createJob.mutateAsync.mockReturnValue(created.promise);

    renderWithClient(<HomePage />);

    await screen.findByText("~802 records");
    const loadButton = screen.getByRole("button", { name: /Load into QuickBooks/ });
    fireEvent.click(loadButton);
    fireEvent.click(loadButton);

    expect(mutationMocks.createJob.mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutationMocks.createJob.mutateAsync).toHaveBeenCalledWith({
      type: "load",
      connectionId: "conn-1",
      templateId: "professional-services",
      config: expect.objectContaining({ templateId: "professional-services" })
    });
    expect(loadButton).toBeDisabled();

    await act(async () => {
      created.resolve(buildJob("job-load", "load"));
      await created.promise;
    });
    expect(mutationMocks.createJob.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it("rolls back a stopped load from its progress card and shows the roll back there", async () => {
    const stopped = {
      ...buildJob("job-load", "load"),
      status: "failed_with_orphans",
      error: "Cancelled after 61 record(s) were created in QuickBooks. Roll back to remove them."
    };
    mutationMocks.createJob.mutateAsync.mockResolvedValue(stopped);
    sharedApi.rollbackJob.mockResolvedValue({
      ...buildJob("job-rollback", "load"),
      type: "rollback"
    });
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    renderWithClient(<HomePage />);
    await screen.findByText("~802 records");
    fireEvent.click(screen.getByRole("button", { name: /Load into QuickBooks/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Roll back" }));

    await waitFor(() => expect(sharedApi.rollbackJob).toHaveBeenCalledWith("job-load"));
    expect(
      await screen.findByText("Rolling back the stopped load in Acme Books")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Roll back" })).not.toBeInTheDocument();
    // A fresh card: nothing of the stopped load (its error, its log) carries over.
    expect(screen.queryByText(/Cancelled after 61 record/)).not.toBeInTheDocument();
    expect(scrollTo).toHaveBeenCalled();
    scrollTo.mockRestore();
  });

  it("names the sandbox a roll back started from Recent activity runs against", async () => {
    const [acme] = hookState.connections;
    hookState.connections = [
      acme!,
      { ...acme!, id: "conn-2", realm_id: "realm-2", company_name: "Beta Books" }
    ];
    hookState.jobs = [
      {
        ...buildJob("job-beta", "load"),
        status: "failed_with_orphans",
        connection_id: "conn-2",
        config: { templateId: "retail", connectionId: "conn-2" },
        error: "Cancelled after 5 record(s) were created in QuickBooks. Roll back to remove them."
      }
    ];
    sharedApi.rollbackJob.mockResolvedValue({
      ...buildJob("job-rollback", "load"),
      type: "rollback",
      connection_id: "conn-2"
    });
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    renderWithClient(<HomePage />);
    const [badge] = await screen.findAllByText("Partly loaded");
    fireEvent.click(badge!.closest("tr")!);
    fireEvent.click(await screen.findByRole("button", { name: "Roll back" }));

    await waitFor(() => expect(sharedApi.rollbackJob).toHaveBeenCalledWith("job-beta"));
    // The form still has Acme Books selected; the card names the rolled-back sandbox.
    expect(
      await screen.findByText("Rolling back the stopped load in Beta Books")
    ).toBeInTheDocument();
    scrollTo.mockRestore();
  });

  it("shows a load whose rollback completed as Rolled back in Recent activity", async () => {
    hookState.jobs = [
      { ...buildJob("job-rolled", "load"), status: "failed", rolled_back: true },
      { ...buildJob("job-failed", "load"), status: "failed" }
    ];

    renderWithClient(<HomePage />);

    expect(await screen.findByText("Rolled back")).toBeInTheDocument();
    expect(screen.getAllByText("Failed")).toHaveLength(1);
  });

  it("names each job in Recent activity after the button that started it", async () => {
    hookState.jobs = [
      { ...buildJob("job-purge", "load"), type: "purge", config: { purgeMode: "generated" } },
      { ...buildJob("job-erase", "load"), type: "purge", config: { purgeMode: "all" } },
      { ...buildJob("job-rollback", "load"), type: "rollback" },
      buildJob("job-generate", "generate"),
      buildJob("job-load", "load")
    ];

    renderWithClient(<HomePage />);

    const table = await screen.findByRole("table");
    for (const label of ["Remove test data", "Erase all data", "Roll back", "Sample files", "Load"]) {
      expect(within(table).getByText(label)).toBeInTheDocument();
    }
    expect(within(table).queryByText(/^purge$/i)).not.toBeInTheDocument();
  });

  it("keeps a sandbox's health dot grey until its health check answers", () => {
    hookState.health = undefined;
    const { container, rerender } = renderWithClient(<HomePage />);
    expect(container.querySelector(".bg-emerald-500")).toBeNull();
    expect(container.querySelector(".bg-slate-300")).not.toBeNull();

    hookState.health = { status: "ok" };
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <HomePage />
      </QueryClientProvider>
    );
    expect(container.querySelector(".bg-emerald-500")).not.toBeNull();
  });

  it("offers Reconnect for an expired sandbox and sends the user to Intuit", async () => {
    const [acme] = hookState.connections;
    if (!acme) throw new Error("fixture has a connection");
    hookState.connections = [{ ...acme, tokenHealth: "expired" }];
    vi.mocked(authorizeConnection).mockResolvedValue({ url: "" });
    renderWithClient(<HomePage />);

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(authorizeConnection).toHaveBeenCalledWith("redirect"));
  });

  it("offers Reconnect when the health check finds unreadable tokens on a young sandbox", () => {
    // The list's tokenHealth is age-based ("ok"); only the detailed health check sees the
    // stored tokens can no longer be read.
    hookState.health = { status: "expired" };
    renderWithClient(<HomePage />);
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("sends a local-mode Reconnect to setup when the Intuit keys are missing", () => {
    appConfig.deployment = "local";
    appConfig.qboConfigured = false;
    const [acme] = hookState.connections;
    if (!acme) throw new Error("fixture has a connection");
    hookState.connections = [{ ...acme, tokenHealth: "expired" }];
    renderWithClient(<HomePage />);

    expect(screen.getByRole("link", { name: "Reconnect" })).toHaveAttribute("href", "/setup");
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  });

  it("offers no Reconnect in Cloud when Intuit keys are not configured", () => {
    appConfig.qboConfigured = false;
    const [acme] = hookState.connections;
    if (!acme) throw new Error("fixture has a connection");
    hookState.connections = [{ ...acme, tokenHealth: "expired" }];
    renderWithClient(<HomePage />);

    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Reconnect" })).not.toBeInTheDocument();
  });

  it("shows the Cloud load allowance, and what still works once it is used up", () => {
    hookState.usage = { deployment: "cloud", limits: { loadsPerMonth: 10 }, usage: { loads: 3 } };
    const { unmount } = renderWithClient(<HomePage />);
    expect(screen.getByText(/3 of 10 loads this month/)).toBeInTheDocument();
    unmount();

    hookState.usage = { deployment: "cloud", limits: { loadsPerMonth: 10 }, usage: { loads: 10 } };
    renderWithClient(<HomePage />);
    expect(screen.getByText(/You've used all 10 loads this month/)).toHaveTextContent(
      "removing data still work"
    );
  });

  it("shows no allowance where loads are unlimited (local mode)", () => {
    hookState.usage = { deployment: "local", limits: { loadsPerMonth: -1 }, usage: { loads: 40 } };
    renderWithClient(<HomePage />);
    expect(screen.queryByText(/loads this month/)).not.toBeInTheDocument();
  });

  it("names each job's sandbox in Recent activity, from the connection list", async () => {
    // Job configs never carry the company name; it used to read from there and show nothing.
    hookState.jobs = [{ ...buildJob("job-load", "load"), connection_id: "conn-1" }];
    renderWithClient(<HomePage />);
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Acme Books")).toBeInTheDocument();
  });

  it("lets a keyboard user pick a sandbox", () => {
    const [acme] = hookState.connections;
    if (!acme) throw new Error("fixture has a connection");
    hookState.connections = [
      acme,
      { ...acme, id: "conn-2", realm_id: "realm-2", company_name: "Beta Books" }
    ];
    renderWithClient(<HomePage />);

    const beta = screen.getByRole("button", { name: "Beta Books" });
    expect(beta).toHaveAttribute("aria-pressed", "false");
    beta.focus();
    fireEvent.click(beta); // Enter/Space on a native button fires click
    expect(beta).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Acme Books" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("locks generate-only launches against duplicate clicks until job creation settles", async () => {
    hookState.connections = [];
    const created = deferred<ReturnType<typeof buildJob>>();
    mutationMocks.createJob.mutateAsync.mockReturnValue(created.promise);

    renderWithClient(<HomePage />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Make sample files/ })
    );
    fireEvent.click(screen.getByRole("button", { name: "Retail / eCommerce" }));

    await screen.findByText("~802 records");
    const generateButton = screen.getByRole("button", { name: /Generate sample files/ });
    fireEvent.click(generateButton);
    fireEvent.click(generateButton);

    expect(mutationMocks.createJob.mutateAsync).toHaveBeenCalledTimes(1);
    const body = mutationMocks.createJob.mutateAsync.mock.calls[0]?.[0];
    expect(body).toMatchObject({ type: "generate", templateId: "retail" });
    // A downloaded file never names a sandbox or a purge.
    expect(body).not.toHaveProperty("connectionId");
    expect(body.config).not.toHaveProperty("connectionId");
    expect(body.config).not.toHaveProperty("purgeMode");
    expect(generateButton).toBeDisabled();

    await act(async () => {
      created.resolve(buildJob("job-generate", "generate"));
      await created.promise;
    });
    expect(mutationMocks.createJob.mutateAsync).toHaveBeenCalledTimes(1);
  });
});

describe("HomePage load readiness", () => {
  const acme = {
    id: "conn-1",
    realm_id: "realm-1",
    company_name: "Acme Books",
    base_url: "https://sandbox-quickbooks.api.intuit.com",
    connected_at: "2026-07-01T00:00:00.000Z",
    last_used_at: null,
    tokenHealth: "ok" as const
  };
  const secondConnection = {
    id: "conn-2",
    realm_id: "realm-2",
    company_name: "Other Co",
    base_url: "https://sandbox-quickbooks.api.intuit.com",
    connected_at: "2026-07-02T00:00:00.000Z",
    last_used_at: null,
    tokenHealth: "ok" as const
  };

  beforeEach(() => {
    hookState.connections = [acme];
    hookState.jobs = [];
    clientMocks.estimateJob.mockReset();
    clientMocks.estimateJob.mockResolvedValue({
      estimatedEntities: 802,
      metrics: { customerCount: 20, invoiceCount: 240 },
      limit: -1
    });
    mutationMocks.createJob.mutateAsync.mockReset();
    mutationMocks.createJob.mutateAsync.mockResolvedValue(buildJob("job-1", "load"));
  });

  afterEach(() => {
    cleanup();
  });

  it("does not launch from a stale or in-flight estimate, and marks the old numbers stale", async () => {
    const first = deferred<{ estimatedEntities: number; metrics: object; limit: number }>();
    clientMocks.estimateJob.mockReturnValueOnce(first.promise);
    renderWithClient(<HomePage />);

    const loadButton = screen.getByRole("button", { name: /Load into QuickBooks/ });
    expect(loadButton).toBeDisabled();
    expect(await screen.findByText("Working out what will be created...")).toBeInTheDocument();

    await act(async () => {
      first.resolve({ estimatedEntities: 802, metrics: { customerCount: 20 }, limit: -1 });
      await first.promise;
    });
    expect(await screen.findByText("~802 records")).toBeInTheDocument();
    expect(loadButton).toBeEnabled();

    // Changing the industry re-estimates: the old numbers stay visible but dimmed, and the
    // button waits for the new estimate.
    const second = deferred<{ estimatedEntities: number; metrics: object; limit: number }>();
    clientMocks.estimateJob.mockReturnValueOnce(second.promise);
    fireEvent.click(screen.getByRole("button", { name: "Retail / eCommerce" }));
    expect(await screen.findByText("Updating the estimate...")).toBeInTheDocument();
    expect(screen.getByText("~802 records").closest("div")).toHaveClass("opacity-50");
    expect(loadButton).toBeDisabled();

    await act(async () => {
      second.resolve({ estimatedEntities: 1200, metrics: { customerCount: 30 }, limit: -1 });
      await second.promise;
    });
    expect(await screen.findByText("~1,200 records")).toBeInTheDocument();
    expect(loadButton).toBeEnabled();
  });

  it("still allows loading when the estimate request fails, and says so", async () => {
    clientMocks.estimateJob.mockRejectedValue(new Error("estimate down"));
    renderWithClient(<HomePage />);

    expect(
      await screen.findByText(/Couldn't work out what will be created\. You can still load it/)
    ).toBeInTheDocument();
    const loadButton = screen.getByRole("button", { name: /Load into QuickBooks/ });
    expect(loadButton).toBeEnabled();
    fireEvent.click(loadButton);
    await waitFor(() => expect(mutationMocks.createJob.mutateAsync).toHaveBeenCalledTimes(1));
  });

  it("blocks loading into a sandbox whose stored token has expired", async () => {
    hookState.connections = [{ ...acme, tokenHealth: "expired" }];
    renderWithClient(<HomePage />);

    await screen.findByText("~802 records");
    expect(screen.getByText("QuickBooks connection expired")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Load into QuickBooks/ })).toBeDisabled();
  });

  it("drops 'clear first' when the chosen sandbox has no earlier load", async () => {
    hookState.connections = [acme, secondConnection];
    hookState.jobs = [completedLoad("job-old", "conn-1")];
    renderWithClient(<HomePage />);

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Remove existing test data (tagged EZTD) first" })
    );
    // Switch to the sandbox that was never loaded: the checkbox goes away ...
    fireEvent.click(screen.getByText("Other Co"));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await screen.findByText("~802 records");
    fireEvent.click(screen.getByRole("button", { name: /Load into QuickBooks/ }));

    // ... and so does the purge it would have carried over.
    await waitFor(() => expect(mutationMocks.createJob.mutateAsync).toHaveBeenCalledTimes(1));
    const body = mutationMocks.createJob.mutateAsync.mock.calls[0]?.[0];
    expect(body.config).not.toHaveProperty("purgeMode");
    expect(body.connectionId).toBe("conn-2");
  });

  it("local mode without Intuit keys: still generates and downloads, and connecting opens /setup", async () => {
    appConfig.deployment = "local";
    appConfig.qboConfigured = false;
    hookState.connections = [];
    mutationMocks.createJob.mutateAsync.mockResolvedValue(buildJob("job-g", "generate"));

    renderWithClient(<HomePage />);

    const connect = await screen.findByRole("link", { name: /Connect QuickBooks Sandbox/ });
    expect(connect).toHaveAttribute("href", "/setup");
    expect(
      screen.queryByRole("button", { name: /Connect QuickBooks Sandbox/ })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Make sample files/ }));
    await screen.findByText("~802 records");
    fireEvent.click(screen.getByRole("button", { name: /Generate sample files/ }));
    await waitFor(() =>
      expect(mutationMocks.createJob.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ type: "generate" })
      )
    );
  });

  it("lets a user with sandboxes stay on the Connect step after clicking Add sandbox", async () => {
    renderWithClient(<HomePage />);
    await screen.findByText("~802 records");

    fireEvent.click(screen.getByRole("button", { name: /Add sandbox/ }));
    expect(screen.getByRole("button", { name: "Add another sandbox" })).toBeInTheDocument();
    // Still there after React settles: no auto-advance for connections that already existed.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Add another sandbox" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue to load data" }));
    expect(screen.queryByRole("button", { name: "Add another sandbox" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Load into QuickBooks/ })).toBeInTheDocument();
  });
});

describe("connectionHasPreviousLoad", () => {
  it("is true only for a finished load on the same connection", () => {
    const jobs = [
      completedLoad("a", "conn-1"),
      { ...buildJob("b", "load"), config: { connectionId: "conn-2" }, status: "completed" },
      { ...buildJob("c", "load"), config: { connectionId: "conn-3" }, status: "failed" },
      { ...buildJob("d", "generate"), config: { connectionId: "conn-4" }, status: "completed" }
    ] as unknown as Job[];
    expect(connectionHasPreviousLoad(jobs, [], "conn-1")).toBe(true);
    expect(connectionHasPreviousLoad(jobs, [], "conn-2")).toBe(true);
    expect(connectionHasPreviousLoad(jobs, [], "conn-3")).toBe(false);
    expect(connectionHasPreviousLoad(jobs, [], "conn-4")).toBe(false);
    expect(connectionHasPreviousLoad(jobs, [], "")).toBe(false);
  });

  it("is true when the server flags the connection, whatever the job list holds", () => {
    const connections = [
      { id: "conn-9", has_prior_load: true },
      { id: "conn-8", has_prior_load: false }
    ] as unknown as QboConnection[];
    expect(connectionHasPreviousLoad([], connections, "conn-9")).toBe(true);
    expect(connectionHasPreviousLoad([], connections, "conn-8")).toBe(false);
  });
});

describe("getResultOneLiner", () => {
  const job = (type: string, result_summary: Record<string, unknown>) =>
    ({ id: "j", type, status: "completed", result_summary }) as unknown as Job;

  it("summarizes load results from their *Created counts", () => {
    expect(
      getResultOneLiner(
        job("load", {
          counts: {
            invoicesCreated: 180,
            billsCreated: 36,
            customersCreated: 15,
            vendorsCreated: 3
          }
        })
      )
    ).toBe("180 invoices, 36 bills, 15 customers");
  });

  it("counts master data a rollback made inactive as rolled back", () => {
    expect(getResultOneLiner(job("rollback", { totalDeleted: 4, totalInactivated: 3 }))).toBe(
      "7 rolled back"
    );
  });

  it("summarizes generate results from the plan metrics", () => {
    expect(
      getResultOneLiner(job("generate", { metrics: { invoiceCount: 1200, paymentCount: 900 } }))
    ).toBe("1,200 invoices, 900 payments");
  });
});

describe("formatDateRange", () => {
  it("shows the calendar month of a date-only string in every timezone", () => {
    expect(formatDateRange("2025-09-01", "2026-08-31")).toBe("Sep 2025 - Aug 2026");
    expect(formatDateRange("2026-01-01", null)).toBe("From Jan 2026");
  });
});

describe("defaultPeriod", () => {
  it("is the 12 full months before today's month, like core's resolvePeriod", () => {
    expect(defaultPeriod(new Date(2026, 8, 24))).toEqual({
      startDate: "2025-09-01",
      endDate: "2026-08-31"
    });
    expect(defaultPeriod(new Date(2026, 0, 15))).toEqual({
      startDate: "2025-01-01",
      endDate: "2025-12-31"
    });
  });

  it("never ends in the future", () => {
    const { endDate } = defaultPeriod();
    expect(endDate < new Date().toISOString().slice(0, 10)).toBe(true);
  });
});

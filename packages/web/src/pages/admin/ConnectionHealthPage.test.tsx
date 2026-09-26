import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionHealthPage } from "./ConnectionHealthPage";

const apiMocks = vi.hoisted(() => ({
  getAdminConnections: vi.fn(),
  testAdminConnection: vi.fn(),
  deleteAdminConnection: vi.fn()
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn()
}));

vi.mock("@/api/admin", () => ({
  getAdminConnections: (...args: unknown[]) => apiMocks.getAdminConnections(...args),
  testAdminConnection: (...args: unknown[]) => apiMocks.testAdminConnection(...args),
  deleteAdminConnection: (...args: unknown[]) => apiMocks.deleteAdminConnection(...args)
}));

vi.mock("sonner", () => ({
  toast: toastMocks
}));

const connections = [
  {
    id: "conn-1",
    company_name: "Acme Books",
    realm_id: "realm-1",
    connected_at: "2026-07-01T10:00:00.000Z",
    last_used_at: "2026-07-07T10:00:00.000Z",
    team_id: "team-1",
    team_name: "Acme Team",
    days_idle: 1,
    job_count: 4
  },
  {
    id: "conn-2",
    company_name: "Beta Books",
    realm_id: "realm-2",
    connected_at: "2026-06-01T10:00:00.000Z",
    last_used_at: null,
    team_id: "team-2",
    team_name: "Beta Team",
    days_idle: 90,
    job_count: 0
  }
];

function renderWithClient(children: ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("ConnectionHealthPage admin actions", () => {
  beforeEach(() => {
    apiMocks.getAdminConnections.mockReset();
    apiMocks.testAdminConnection.mockReset();
    apiMocks.deleteAdminConnection.mockReset();
    toastMocks.success.mockReset();
    toastMocks.error.mockReset();
    apiMocks.getAdminConnections.mockResolvedValue({
      connections,
      total: connections.length,
      page: 1,
      limit: 50
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("locks connection test controls while a test request is pending", async () => {
    let resolveTest!: (value: unknown) => void;
    apiMocks.testAdminConnection.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTest = resolve;
        })
    );

    renderWithClient(<ConnectionHealthPage />);

    const testButton = await screen.findByRole("button", { name: "Test Acme Books" });
    fireEvent.click(testButton);
    fireEvent.click(testButton);

    await waitFor(() => {
      expect(apiMocks.testAdminConnection).toHaveBeenCalledWith("conn-1");
    });
    expect(apiMocks.testAdminConnection).toHaveBeenCalledTimes(1);
    expect(testButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Beta Books" })).toBeDisabled();

    await act(async () => {
      resolveTest({ ok: true, companyName: "Acme Books" });
    });

    await waitFor(() => {
      expect(toastMocks.success).toHaveBeenCalledWith("Connection OK: Acme Books");
    });
  });

  it("locks connection delete controls while a delete request is pending", async () => {
    let resolveDelete!: (value: unknown) => void;
    let resolveConnectionsRefetch!: (value: unknown) => void;
    apiMocks.getAdminConnections.mockReset();
    apiMocks.getAdminConnections.mockResolvedValueOnce({
      connections,
      total: connections.length,
      page: 1,
      limit: 50
    });
    apiMocks.getAdminConnections.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConnectionsRefetch = resolve;
        })
    );
    apiMocks.deleteAdminConnection.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve;
        })
    );

    renderWithClient(<ConnectionHealthPage />);

    const deleteButton = await screen.findByRole("button", { name: "Delete Acme Books" });
    fireEvent.click(deleteButton);
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(apiMocks.deleteAdminConnection).toHaveBeenCalledWith("conn-1");
    });
    expect(apiMocks.deleteAdminConnection).toHaveBeenCalledTimes(1);
    expect(deleteButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Test Beta Books" })).toBeDisabled();

    await act(async () => {
      resolveDelete({});
    });

    await waitFor(() => {
      expect(apiMocks.getAdminConnections).toHaveBeenCalledTimes(2);
    });
    expect(deleteButton).toBeDisabled();

    await act(async () => {
      resolveConnectionsRefetch({
        connections,
        total: connections.length,
        page: 1,
        limit: 50
      });
    });

    await waitFor(() => {
      expect(toastMocks.success).toHaveBeenCalledWith("Connection removed");
    });
    await waitFor(() => {
      expect(deleteButton).not.toBeDisabled();
    });
  });
});

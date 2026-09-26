import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserManagementPage } from "./UserManagementPage";

const apiMocks = vi.hoisted(() => ({
  getAdminUsers: vi.fn(),
  suspendUser: vi.fn(),
  unsuspendUser: vi.fn()
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn()
}));

const clientMocks = vi.hoisted(() => ({
  adminDownload: vi.fn()
}));

vi.mock("@/api/admin", () => ({
  getAdminUsers: (...args: unknown[]) => apiMocks.getAdminUsers(...args),
  suspendUser: (...args: unknown[]) => apiMocks.suspendUser(...args),
  unsuspendUser: (...args: unknown[]) => apiMocks.unsuspendUser(...args)
}));

vi.mock("@/api/client", () => ({
  adminDownload: (...args: unknown[]) => clientMocks.adminDownload(...args)
}));

vi.mock("sonner", () => ({
  toast: toastMocks
}));

const users = [
  {
    id: "user-1",
    email: "active@example.com",
    display_name: "Active User",
    oauth_provider: "intuit",
    avatar_url: null,
    is_admin: false,
    suspended_at: null,
    suspended_reason: null,
    created_at: "2026-07-08T10:00:00.000Z",
    team_count: 1,
    job_count: 3
  },
  {
    id: "user-2",
    email: "suspended@example.com",
    display_name: "Suspended User",
    oauth_provider: "google",
    avatar_url: null,
    is_admin: false,
    suspended_at: "2026-07-08T12:00:00.000Z",
    suspended_reason: "Suspended by admin",
    created_at: "2026-07-08T10:00:00.000Z",
    team_count: 1,
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

describe("UserManagementPage admin actions", () => {
  beforeEach(() => {
    apiMocks.getAdminUsers.mockReset();
    apiMocks.suspendUser.mockReset();
    apiMocks.unsuspendUser.mockReset();
    clientMocks.adminDownload.mockReset();
    toastMocks.success.mockReset();
    toastMocks.error.mockReset();
    apiMocks.getAdminUsers.mockResolvedValue({
      users,
      total: users.length,
      page: 1,
      limit: 50
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("locks user export while the CSV download is pending", async () => {
    let resolveDownload!: (value: unknown) => void;
    clientMocks.adminDownload.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDownload = resolve;
        })
    );

    renderWithClient(<UserManagementPage />);

    const suspendButton = await screen.findByRole("button", {
      name: "Suspend active@example.com"
    });
    const exportButton = screen.getByRole("button", { name: "Export CSV" });
    fireEvent.click(exportButton);
    fireEvent.click(exportButton);

    await waitFor(() => {
      expect(clientMocks.adminDownload).toHaveBeenCalledWith(
        "/admin/users/export?format=csv",
        "users.csv"
      );
    });
    expect(clientMocks.adminDownload).toHaveBeenCalledTimes(1);
    expect(exportButton).toBeDisabled();
    expect(suspendButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Unsuspend suspended@example.com" })).toBeDisabled();

    await act(async () => {
      resolveDownload(undefined);
    });

    await waitFor(() => {
      expect(exportButton).not.toBeDisabled();
    });
  });

  it("locks user suspend controls while a suspend request is pending", async () => {
    let resolveSuspend!: (value: unknown) => void;
    let resolveRefetch!: (value: unknown) => void;
    apiMocks.getAdminUsers.mockReset();
    apiMocks.getAdminUsers.mockResolvedValueOnce({
      users,
      total: users.length,
      page: 1,
      limit: 50
    });
    apiMocks.getAdminUsers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefetch = resolve;
        })
    );
    apiMocks.suspendUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSuspend = resolve;
        })
    );

    renderWithClient(<UserManagementPage />);

    const suspendButton = await screen.findByRole("button", {
      name: "Suspend active@example.com"
    });
    fireEvent.click(suspendButton);
    fireEvent.click(suspendButton);

    await waitFor(() => {
      expect(apiMocks.suspendUser).toHaveBeenCalledWith("user-1", "Suspended by admin");
    });
    expect(apiMocks.suspendUser).toHaveBeenCalledTimes(1);
    expect(suspendButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Unsuspend suspended@example.com" })).toBeDisabled();

    await act(async () => {
      resolveSuspend({});
    });

    await waitFor(() => {
      expect(toastMocks.success).toHaveBeenCalledWith("User suspended");
    });
    await waitFor(() => {
      expect(apiMocks.getAdminUsers).toHaveBeenCalledTimes(2);
    });
    expect(suspendButton).toBeDisabled();

    await act(async () => {
      resolveRefetch({
        users,
        total: users.length,
        page: 1,
        limit: 50
      });
    });

    await waitFor(() => {
      expect(suspendButton).not.toBeDisabled();
    });
  });

  it("locks user unsuspend controls while an unsuspend request is pending", async () => {
    let resolveUnsuspend!: (value: unknown) => void;
    apiMocks.unsuspendUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUnsuspend = resolve;
        })
    );

    renderWithClient(<UserManagementPage />);

    const unsuspendButton = await screen.findByRole("button", {
      name: "Unsuspend suspended@example.com"
    });
    fireEvent.click(unsuspendButton);
    fireEvent.click(unsuspendButton);

    await waitFor(() => {
      expect(apiMocks.unsuspendUser).toHaveBeenCalledWith("user-2");
    });
    expect(apiMocks.unsuspendUser).toHaveBeenCalledTimes(1);
    expect(unsuspendButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Suspend active@example.com" })).toBeDisabled();

    await act(async () => {
      resolveUnsuspend({});
    });

    await waitFor(() => {
      expect(toastMocks.success).toHaveBeenCalledWith("User unsuspended");
    });
  });
});

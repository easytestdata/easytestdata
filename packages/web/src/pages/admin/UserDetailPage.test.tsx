import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserDetailPage } from "./UserDetailPage";

const apiMocks = vi.hoisted(() => ({
  getAdminUser: vi.fn(),
  suspendUser: vi.fn(),
  unsuspendUser: vi.fn(),
  revokeUserSessions: vi.fn()
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn()
}));

vi.mock("@/api/admin", () => ({
  getAdminUser: (...args: unknown[]) => apiMocks.getAdminUser(...args),
  suspendUser: (...args: unknown[]) => apiMocks.suspendUser(...args),
  unsuspendUser: (...args: unknown[]) => apiMocks.unsuspendUser(...args),
  revokeUserSessions: (...args: unknown[]) => apiMocks.revokeUserSessions(...args)
}));

vi.mock("sonner", () => ({
  toast: toastMocks
}));

const adminUserDetail = {
  user: {
    id: "user-1",
    email: "admin-user@example.com",
    display_name: "Admin User",
    oauth_provider: "github",
    avatar_url: null,
    is_admin: true,
    suspended_at: null,
    suspended_reason: null,
    created_at: "2026-07-08T10:00:00.000Z",
    team_count: 1,
    job_count: 2
  },
  teams: [{ id: "team-1", name: "Team One", role: "owner" }],
  recentJobs: []
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

function renderUserDetailPage() {
  return renderWithClient(
    <MemoryRouter initialEntries={["/admin/users/user-1"]}>
      <Routes>
        <Route path="/admin/users/:id" element={<UserDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("UserDetailPage admin actions", () => {
  beforeEach(() => {
    apiMocks.getAdminUser.mockReset();
    apiMocks.suspendUser.mockReset();
    apiMocks.unsuspendUser.mockReset();
    apiMocks.revokeUserSessions.mockReset();
    toastMocks.success.mockReset();
    toastMocks.error.mockReset();
    apiMocks.getAdminUser.mockResolvedValue(adminUserDetail);
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the sign-in provider", async () => {
    renderUserDetailPage();
    expect(await screen.findByText("github")).toBeInTheDocument();
  });

  it("locks user actions while a request is pending", async () => {
    let resolveSuspend!: (value: unknown) => void;
    let resolveUserRefetch!: (value: unknown) => void;
    apiMocks.getAdminUser.mockReset();
    apiMocks.getAdminUser.mockResolvedValueOnce(adminUserDetail);
    apiMocks.getAdminUser.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUserRefetch = resolve;
        })
    );
    apiMocks.suspendUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSuspend = resolve;
        })
    );

    renderUserDetailPage();

    const suspendButton = await screen.findByRole("button", { name: /suspend/i });
    fireEvent.click(suspendButton);
    fireEvent.click(suspendButton);

    await waitFor(() => {
      expect(apiMocks.suspendUser).toHaveBeenCalledWith("user-1", "Suspended by admin");
    });
    expect(apiMocks.suspendUser).toHaveBeenCalledTimes(1);
    expect(suspendButton).toBeDisabled();
    expect(screen.getByRole("button", { name: /Revoke All Sessions/i })).toBeDisabled();

    await act(async () => {
      resolveSuspend({});
    });

    await waitFor(() => {
      expect(apiMocks.getAdminUser).toHaveBeenCalledTimes(2);
    });
    expect(suspendButton).toBeDisabled();

    await act(async () => {
      resolveUserRefetch(adminUserDetail);
    });

    await waitFor(() => {
      expect(toastMocks.success).toHaveBeenCalledWith("User suspended");
    });
    await waitFor(() => {
      expect(suspendButton).not.toBeDisabled();
    });
  });
});

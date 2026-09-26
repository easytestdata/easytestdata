import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvitePage } from "./InvitePage";

const authState = {
  user: null as null | { id: string; email: string; displayName: string; avatarUrl: string | null },
  loading: false
};

const acceptTeamInviteMock = vi.fn();

vi.mock("../contexts/AuthContext", () => ({
  useAuth: () => authState
}));

vi.mock("../api/client", () => ({
  acceptTeamInvite: (...args: unknown[]) => acceptTeamInviteMock(...args)
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}));

function LoginRouteSpy() {
  const location = useLocation();
  return <div>login-route{location.search}</div>;
}

describe("InvitePage", () => {
  beforeEach(() => {
    authState.user = null;
    authState.loading = false;
    acceptTeamInviteMock.mockReset();
  });

  it("redirects unauthenticated users to login while preserving invite token", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/invite?token=invite_abc"]}>
          <Routes>
            <Route path="/invite" element={<InvitePage />} />
            <Route path="/login" element={<LoginRouteSpy />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(await screen.findByText("login-route?invite_token=invite_abc")).toBeInTheDocument();
    expect(acceptTeamInviteMock).not.toHaveBeenCalled();
  });

  it("accepts invite for authenticated users and routes to team settings", async () => {
    authState.user = {
      id: "u1",
      email: "user@example.com",
      displayName: "User",
      avatarUrl: null
    };
    acceptTeamInviteMock.mockResolvedValueOnce({ accepted: true, teamId: "team-1" });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/invite?token=invite_abc"]}>
          <Routes>
            <Route path="/invite" element={<InvitePage />} />
            <Route path="/settings/team" element={<div>team-settings-route</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(acceptTeamInviteMock).toHaveBeenCalledWith("invite_abc");
    });
    expect(await screen.findByText("team-settings-route")).toBeInTheDocument();
  });

  it("lets authenticated users retry a failed invite acceptance", async () => {
    authState.user = {
      id: "u1",
      email: "user@example.com",
      displayName: "User",
      avatarUrl: null
    };
    acceptTeamInviteMock
      .mockRejectedValueOnce(new Error("Temporary invite failure"))
      .mockResolvedValueOnce({ accepted: true, teamId: "team-1" });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/invite?token=invite_abc"]}>
          <Routes>
            <Route path="/invite" element={<InvitePage />} />
            <Route path="/settings/team" element={<div>team-settings-route</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(await screen.findByText("Temporary invite failure")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => {
      expect(acceptTeamInviteMock).toHaveBeenCalledTimes(2);
    });
    expect(acceptTeamInviteMock).toHaveBeenNthCalledWith(2, "invite_abc");
    expect(await screen.findByText("team-settings-route")).toBeInTheDocument();
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamSection } from "./TeamSection";

const authState = vi.hoisted(() => ({
  value: {
    teamId: "team-1",
    user: { id: "user-1" },
    switchTeam: vi.fn()
  }
}));

const teamsState = vi.hoisted(() => ({
  value: {
    data: [{ id: "team-1", name: "Team One", role: "owner" }]
  }
}));

const membersState = vi.hoisted(() => ({
  value: {
    data: [],
    isLoading: false,
    refetch: vi.fn()
  }
}));

const apiMocks = vi.hoisted(() => ({
  getTeamInvites: vi.fn(),
  inviteTeamMember: vi.fn()
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn()
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => authState.value
}));

vi.mock("@/api/hooks", () => ({
  useTeamMembers: () => membersState.value,
  useTeams: () => teamsState.value
}));

vi.mock("@/api/client", () => ({
  getTeamInvites: (...args: unknown[]) => apiMocks.getTeamInvites(...args),
  inviteTeamMember: (...args: unknown[]) => apiMocks.inviteTeamMember(...args),
  removeTeamMember: vi.fn(),
  revokeTeamInvite: vi.fn()
}));

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigateMock
}));

vi.mock("sonner", () => ({
  toast: toastMocks
}));

function renderTeamSection() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false }
    }
  });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TeamSection />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("TeamSection", () => {
  beforeEach(() => {
    apiMocks.getTeamInvites.mockResolvedValue([]);
    apiMocks.inviteTeamMember.mockReset();
    membersState.value.refetch.mockReset();
    toastMocks.success.mockReset();
    toastMocks.error.mockReset();
    toastMocks.info.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("locks the invite form while an invite request is pending", async () => {
    let resolveInvite!: (value: unknown) => void;
    apiMocks.inviteTeamMember.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInvite = resolve;
        })
    );

    renderTeamSection();

    const emailInput = screen.getByPlaceholderText("colleague@example.com");
    fireEvent.change(emailInput, { target: { value: "  Invitee@Example.com  " } });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    await waitFor(() => {
      expect(apiMocks.inviteTeamMember).toHaveBeenCalledWith(
        "team-1",
        "Invitee@Example.com",
        "member"
      );
    });
    expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();
    expect(emailInput).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Creating..." }));
    expect(apiMocks.inviteTeamMember).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInvite({
        id: "invite-1",
        email: "invitee@example.com",
        role: "member",
        expires_at: "2026-07-15T10:00:00.000Z",
        created_at: "2026-07-08T10:00:00.000Z",
        inviteUrl: "http://localhost:28080/invite?token=abc"
      });
    });

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith("Invite link created"));
  });

  it("says a re-invited address got a new link", async () => {
    apiMocks.inviteTeamMember.mockResolvedValue({
      id: "invite-existing",
      email: "invitee@example.com",
      role: "member",
      expires_at: "2026-07-15T10:00:00.000Z",
      created_at: "2026-07-08T10:00:00.000Z",
      alreadyPending: true,
      inviteUrl: "http://localhost:28080/invite?token=new"
    });

    renderTeamSection();

    fireEvent.change(screen.getByPlaceholderText("colleague@example.com"), {
      target: { value: "invitee@example.com" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    await waitFor(() => {
      expect(toastMocks.success).toHaveBeenCalledWith(
        "New invite link created; the earlier link no longer works."
      );
    });
    expect(screen.getByLabelText("Invite link")).toHaveValue(
      "http://localhost:28080/invite?token=new"
    );
  });

  it("shows a copyable invite link", async () => {
    apiMocks.inviteTeamMember.mockResolvedValue({
      id: "invite-2",
      email: "b@example.com",
      role: "member",
      expires_at: "2026-07-15T10:00:00.000Z",
      created_at: "2026-07-08T10:00:00.000Z",
      inviteUrl: "http://localhost:3000/invite?token=abc"
    });
    renderTeamSection();
    fireEvent.change(screen.getByPlaceholderText("colleague@example.com"), {
      target: { value: "b@example.com" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    expect(await screen.findByText(/Share this link with/)).toBeInTheDocument();
    expect(screen.getByLabelText("Invite link")).toHaveValue(
      "http://localhost:3000/invite?token=abc"
    );
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("switches teams: new session, cleared cache, back to /home", async () => {
    teamsState.value = {
      data: [
        { id: "team-1", name: "Team One", role: "owner" },
        { id: "team-2", name: "Team Two", role: "member" }
      ]
    };
    authState.value.switchTeam.mockResolvedValue(undefined);
    renderTeamSection();

    expect(screen.getByText("Current")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Switch to Team Two" }));

    await waitFor(() => expect(authState.value.switchTeam).toHaveBeenCalledWith("team-2"));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/home"));
    teamsState.value = {
      data: [{ id: "team-1", name: "Team One", role: "owner" }]
    };
  });
});

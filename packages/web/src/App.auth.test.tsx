import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storeTokens } from "@easytestdata/shared/api-client";
import * as api from "./api/client";
import { App } from "./App";
import { useAuth } from "./contexts/AuthContext";

vi.mock("./api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/client")>()),
  exchangeOAuthCode: vi.fn(),
  switchTeam: vi.fn(),
  getProfile: vi.fn()
}));

vi.mock("./contexts/SentryContext", () => ({
  SentryProvider: ({ children }: { children: ReactNode }) => children,
  SentryErrorBoundary: ({ children }: { children: ReactNode }) => children,
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  setSentryUser: vi.fn()
}));

vi.mock("./contexts/AppConfigContext", () => ({
  AppConfigProvider: ({ children }: { children: ReactNode }) => children,
  useAppConfig: () => ({
    loading: false,
    deployment: "cloud",
    enabledOAuthProviders: ["google"],
    marketingUrl: "https://easytestdata.com"
  })
}));

vi.mock("./pages/HomePage", () => ({
  HomePage: () => {
    const { switchTeam, exchangeOAuthCode } = useAuth();
    return (
      <>
        <div>home-page</div>
        <button onClick={() => void switchTeam("team-2")}>Switch team</button>
        <button onClick={() => void exchangeOAuthCode("other-account")}>Change account</button>
      </>
    );
  }
}));
vi.mock("./pages/admin/UserManagementPage", () => ({
  UserManagementPage: () => <div>admin-users-page</div>
}));

const SESSION: api.AuthResponse = {
  user: { id: "user-1", email: "user@example.com", displayName: "User", avatarUrl: null },
  teamId: "team-1",
  accessToken: `header.${btoa(JSON.stringify({ sub: "user-1", teamId: "team-1" }))}.sig`,
  refreshToken: "refresh-token"
};
const DESTINATION = "/admin/users?status=active#list";

function renderAt(path: string) {
  window.history.replaceState({}, "", path);
  return render(<App />);
}

describe("admin destinations with the real AuthProvider and AdminLayout", () => {
  beforeEach(() => {
    api.logout();
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(api.getProfile).mockReset();
    vi.mocked(api.exchangeOAuthCode).mockReset();
    vi.mocked(api.switchTeam).mockReset();
    vi.mocked(api.exchangeOAuthCode).mockImplementation(async () => {
      storeTokens(SESSION);
      return SESSION;
    });
    vi.mocked(api.switchTeam).mockImplementation(async (teamId) => {
      const session = {
        ...SESSION,
        teamId,
        accessToken: `header.${btoa(JSON.stringify({ sub: SESSION.user.id, teamId }))}.sig`
      };
      storeTokens(session);
      return session;
    });
  });

  afterEach(() => cleanup());

  it.each([
    new api.ApiError("Profile unavailable", 503, {}),
    new api.ApiError("Too many requests", 429, {}),
    new TypeError("Failed to fetch")
  ])(
    "keeps the admin link after a same-account team switch when the profile fails: %s",
    async (error) => {
      storeTokens(SESSION);
      vi.mocked(api.getProfile).mockResolvedValueOnce({
        id: SESSION.user.id,
        email: SESSION.user.email,
        display_name: SESSION.user.displayName,
        avatar_url: null,
        is_admin: true
      });
      renderAt("/home");
      expect(await screen.findByRole("link", { name: "Admin" })).toBeVisible();

      let rejectProfile!: (error: unknown) => void;
      vi.mocked(api.getProfile).mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectProfile = reject;
        })
      );
      fireEvent.click(screen.getByRole("button", { name: "Switch team" }));
      await waitFor(() => expect(api.getProfile).toHaveBeenCalledTimes(2));
      expect(api.switchTeam).toHaveBeenCalledWith("team-2");
      await act(async () => rejectProfile(error));
      expect(screen.getByRole("link", { name: "Admin" })).toBeVisible();
      expect(screen.getByText("home-page")).toBeVisible();
      expect(api.getAccessToken()).toContain(
        btoa(JSON.stringify({ sub: SESSION.user.id, teamId: "team-2" }))
      );
    }
  );

  it.each(["tokens", "oauth"])(
    "hides the admin link throughout a different account's profile load via %s",
    async (source) => {
      storeTokens(SESSION);
      vi.mocked(api.getProfile).mockResolvedValueOnce({
        id: SESSION.user.id,
        email: SESSION.user.email,
        display_name: SESSION.user.displayName,
        avatar_url: null,
        is_admin: true
      });
      renderAt("/home");
      expect(await screen.findByRole("link", { name: "Admin" })).toBeVisible();

      const otherSession: api.AuthResponse = {
        ...SESSION,
        user: { ...SESSION.user, id: "user-2", displayName: "Other user" },
        accessToken: `header.${btoa(JSON.stringify({ sub: "user-2", teamId: SESSION.teamId }))}.sig`
      };
      let resolveProfile!: (profile: Awaited<ReturnType<typeof api.getProfile>>) => void;
      vi.mocked(api.getProfile).mockReturnValue(
        new Promise((resolve) => {
          resolveProfile = resolve;
        })
      );
      if (source === "tokens") {
        act(() => storeTokens(otherSession));
      } else {
        vi.mocked(api.exchangeOAuthCode).mockImplementationOnce(async () => {
          storeTokens(otherSession);
          return otherSession;
        });
        fireEvent.click(screen.getByRole("button", { name: "Change account" }));
      }
      await act(async () => {});
      expect(api.getProfile).toHaveBeenCalledTimes(source === "tokens" ? 2 : 3);
      expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();

      await act(async () => {
        resolveProfile({
          id: otherSession.user.id,
          email: otherSession.user.email,
          display_name: otherSession.user.displayName,
          avatar_url: null,
          is_admin: false
        });
      });
      expect(screen.getByText("home-page")).toBeVisible();
      expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
    }
  );

  it.each([true, false])(
    "waits for the profile after OAuth before deciding admin access (is_admin=%s)",
    async (isAdmin) => {
      const first = renderAt(DESTINATION);
      await screen.findByText("Sign in");
      expect(window.location.pathname).toBe("/login");
      expect(new URLSearchParams(window.location.search).get("next")).toBe(DESTINATION);
      expect(sessionStorage.getItem("easytestdata:pending-destination")).toBe(DESTINATION);
      first.unmount();

      let resolveProfile!: (profile: Awaited<ReturnType<typeof api.getProfile>>) => void;
      const profile = new Promise<Awaited<ReturnType<typeof api.getProfile>>>((resolve) => {
        resolveProfile = resolve;
      });
      vi.mocked(api.getProfile).mockReturnValueOnce(profile);
      renderAt("/login?auth_code=oauth_abc");
      await waitFor(() => expect(api.getProfile).toHaveBeenCalledTimes(1));
      // Flush the user update, route change and guard effects while the profile stays pending.
      await act(async () => {});
      expect(api.exchangeOAuthCode).toHaveBeenCalledWith("oauth_abc");
      expect(window.location.pathname + window.location.search + window.location.hash).toBe(
        DESTINATION
      );
      expect(screen.queryByText("home-page")).not.toBeInTheDocument();
      expect(screen.queryByText("admin-users-page")).not.toBeInTheDocument();

      await act(async () => {
        resolveProfile({
          id: SESSION.user.id,
          email: SESSION.user.email,
          display_name: SESSION.user.displayName,
          avatar_url: null,
          is_admin: isAdmin
        });
      });

      expect(await screen.findByText(isAdmin ? "admin-users-page" : "home-page")).toBeVisible();
      expect(window.location.pathname + window.location.search + window.location.hash).toBe(
        isAdmin ? DESTINATION : "/home"
      );
      expect(sessionStorage.length).toBe(0);
    }
  );
});

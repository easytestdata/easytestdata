import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";

// A JWT-shaped token with the given claims (the provider only decodes the payload).
function token(claims: Record<string, string>) {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(claims)}.sig`;
}

const state = vi.hoisted(() => ({ accessToken: "", profiles: {} as Record<string, object> }));

vi.mock("../api/client", () => ({
  TOKENS_CHANGED_EVENT: "easytestdata:tokens",
  ApiError: class ApiError extends Error {
    status = 0;
  },
  isAuthenticated: () => Boolean(state.accessToken),
  getAccessToken: () => state.accessToken,
  getProfile: vi.fn(async () => {
    const sub = JSON.parse(atob(state.accessToken.split(".")[1] ?? "")).sub as string;
    return state.profiles[sub];
  }),
  clearTokens: vi.fn(),
  logout: vi.fn()
}));
vi.mock("./SentryContext", () => ({ setSentryUser: () => {} }));
const appConfig = vi.hoisted(() => ({ loading: false, deployment: "cloud" as "cloud" | "local" }));
vi.mock("./AppConfigContext", () => ({ useAppConfig: () => appConfig }));

import { AuthProvider, useAuth } from "./AuthContext";

const alice = {
  id: "alice",
  email: "alice@x.com",
  display_name: "Alice",
  is_admin: true
};
const bob = {
  id: "bob",
  email: "bob@x.com",
  display_name: "Bob",
  is_admin: false
};

afterEach(() => {
  cleanup();
  vi.mocked(api.getProfile).mockReset();
});

describe("AuthProvider in local mode", () => {
  beforeEach(() => {
    appConfig.loading = true;
    appConfig.deployment = "local";
    state.accessToken = "";
  });

  it("waits for the config, then loads the built-in user without any token", async () => {
    const api = await import("../api/client");
    vi.mocked(api.getProfile).mockClear();
    vi.mocked(api.getProfile).mockResolvedValueOnce({
      id: "local-user",
      email: "local@easytestdata.local",
      display_name: "Local user",
      avatar_url: null,
      is_admin: false,
      team_id: "local-team"
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result, rerender } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.loading).toBe(true);
    expect(api.getProfile).not.toHaveBeenCalled();

    appConfig.loading = false;
    rerender();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user?.id).toBe("local-user");
    expect(result.current.teamId).toBe("local-team");
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.profileLoading).toBe(false);

    // Local mode never has tokens: a tokens-changed event does not sign the built-in user out.
    act(() => {
      window.dispatchEvent(new Event("easytestdata:tokens"));
    });
    expect(result.current.user?.id).toBe("local-user");
  });
});

describe("AuthProvider when another tab's tokens are adopted", () => {
  beforeEach(() => {
    appConfig.loading = false;
    appConfig.deployment = "cloud";
    state.profiles = { alice, bob };
    state.accessToken = token({ sub: "alice", teamId: "team-shared" });
  });

  it("replaces the whole user state when the tokens belong to another account", async () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user?.id).toBe("alice"));
    expect(result.current.isAdmin).toBe(true);
    queryClient.setQueryData(["jobs"], ["alice-job"]);

    // Same team, different account: only the user id tells them apart.
    state.accessToken = token({ sub: "bob", teamId: "team-shared" });
    act(() => {
      window.dispatchEvent(new Event("easytestdata:tokens"));
    });

    await waitFor(() => expect(result.current.user?.id).toBe("bob"));
    expect(result.current.user?.email).toBe("bob@x.com");
    expect(result.current.isAdmin).toBe(false);
    expect(queryClient.getQueryData(["jobs"])).toBeUndefined();
  });

  it("signs out when the API client clears the tokens itself (a rejected refresh)", async () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user?.id).toBe("alice"));
    queryClient.setQueryData(["jobs"], ["alice-job"]);

    state.accessToken = "";
    act(() => {
      window.dispatchEvent(new Event("easytestdata:tokens"));
    });

    await waitFor(() => expect(result.current.user).toBeNull());
    expect(result.current.teamId).toBeNull();
    expect(result.current.isAdmin).toBe(false);
    expect(queryClient.getQueryData(["jobs"])).toBeUndefined();
  });

  it("signs in when another tab signs in (a signed-out tab follows)", async () => {
    state.accessToken = "";
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();

    state.accessToken = token({ sub: "bob", teamId: "team-bob" });
    act(() => {
      window.dispatchEvent(
        new CustomEvent("easytestdata:tokens", { detail: { fromOtherTab: true } })
      );
    });
    await waitFor(() => expect(result.current.user?.id).toBe("bob"));
  });

  it("only follows the team for the same account's new tokens", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user?.id).toBe("alice"));

    state.accessToken = token({ sub: "alice", teamId: "team-other" });
    act(() => {
      window.dispatchEvent(new Event("easytestdata:tokens"));
    });
    await waitFor(() => expect(result.current.teamId).toBe("team-other"));
    expect(result.current.user?.id).toBe("alice");
  });
});

describe("AuthProvider profile permissions", () => {
  beforeEach(() => {
    appConfig.loading = false;
    appConfig.deployment = "cloud";
    state.profiles = { alice, bob };
    state.accessToken = token({ sub: "alice", teamId: "team-shared" });
  });

  function renderAuth() {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    return renderHook(() => useAuth(), { wrapper });
  }

  function deferProfile() {
    let resolve!: (profile: Awaited<ReturnType<typeof api.getProfile>>) => void;
    const promise = new Promise<Awaited<ReturnType<typeof api.getProfile>>>((done) => {
      resolve = done;
    });
    vi.mocked(api.getProfile).mockReturnValueOnce(promise);
    return resolve;
  }

  it("discards a profile for a different current token subject and loads the current account", async () => {
    const resolveAlice = deferProfile();
    const { result } = renderAuth();
    expect(result.current.profileLoading).toBe(true);

    // Check the token at response time even if no token event invalidated this request.
    state.accessToken = token({ sub: "bob", teamId: "team-bob" });
    const resolveBob = deferProfile();
    await act(async () => resolveAlice({ ...alice, avatar_url: null }));
    expect(result.current.user).toBeNull();
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.profileLoading).toBe(true);

    await act(async () => resolveBob({ ...bob, avatar_url: null }));
    expect(result.current.user?.id).toBe("bob");
    expect(result.current.teamId).toBe("team-bob");
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.profileLoading).toBe(false);
  });

  it.each(["", token({ teamId: "team-shared" })])(
    "discards a Cloud profile when the current token has no subject (%j)",
    async (accessToken) => {
      const resolveProfile = deferProfile();
      const { result } = renderAuth();
      state.accessToken = accessToken;

      await act(async () => resolveProfile({ ...alice, avatar_url: null }));
      expect(result.current.user).toBeNull();
      expect(result.current.isAdmin).toBe(false);
      expect(result.current.profileLoading).toBe(false);
    }
  );

  it("hides the previous account's admin permission while the next profile is pending", async () => {
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.isAdmin).toBe(true));

    const resolveProfile = deferProfile();
    act(() => {
      state.accessToken = token({ sub: "bob", teamId: "team-shared" });
      window.dispatchEvent(new CustomEvent(api.TOKENS_CHANGED_EVENT));
    });
    expect(result.current.profileLoading).toBe(true);
    expect(result.current.isAdmin).toBe(false);

    await act(async () => resolveProfile({ ...bob, avatar_url: null }));
    expect(result.current.profileLoading).toBe(false);
    expect(result.current.user?.id).toBe("bob");
    expect(result.current.isAdmin).toBe(false);
  });

  it("ignores an older profile without ending the current permission load", async () => {
    const resolveAlice = deferProfile();
    const { result } = renderAuth();
    expect(result.current.profileLoading).toBe(true);

    const resolveBob = deferProfile();
    act(() => {
      state.accessToken = token({ sub: "bob", teamId: "team-shared" });
      window.dispatchEvent(
        new CustomEvent(api.TOKENS_CHANGED_EVENT, { detail: { fromOtherTab: true } })
      );
    });
    await act(async () => resolveAlice({ ...alice, avatar_url: null }));
    expect(result.current.profileLoading).toBe(true);
    expect(result.current.user).toBeNull();
    expect(result.current.isAdmin).toBe(false);

    await act(async () => resolveBob({ ...bob, avatar_url: null }));
    expect(result.current.profileLoading).toBe(false);
    expect(result.current.user?.id).toBe("bob");
    expect(result.current.isAdmin).toBe(false);
  });

  it("cannot restore admin permission when a pending profile finishes after logout", async () => {
    const resolveProfile = deferProfile();
    const { result } = renderAuth();
    expect(result.current.profileLoading).toBe(true);
    act(() => result.current.logout());
    expect(result.current.profileLoading).toBe(false);

    await act(async () => resolveProfile({ ...alice, avatar_url: null }));
    expect(result.current.user).toBeNull();
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.profileLoading).toBe(false);
  });

  it("settles a failed permission request without granting admin access", async () => {
    vi.mocked(api.getProfile).mockRejectedValueOnce(new Error("Profile unavailable"));
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.profileLoading).toBe(false);
    expect(result.current.isAdmin).toBe(false);
  });
});

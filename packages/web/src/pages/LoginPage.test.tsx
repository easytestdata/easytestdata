import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";

type User = { id: string; email: string; displayName: string; avatarUrl: string | null };

const authState = {
  user: null as null | User,
  exchangeOAuthCode: vi.fn()
};

vi.mock("../contexts/AuthContext", () => ({
  useAuth: () => authState
}));

const appConfig = vi.hoisted(() => ({
  deployment: "cloud" as "cloud" | "local",
  enabledOAuthProviders: ["google", "github", "intuit"] as string[],
  marketingUrl: "https://marketing.example"
}));

vi.mock("@/contexts/AppConfigContext", () => ({
  useAppConfig: () => appConfig
}));

function DestinationRoute() {
  const { pathname, search, hash } = useLocation();
  return <div>{pathname + search + hash}</div>;
}

function LoginRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/home" element={<div>home-route</div>} />
      <Route path="/invite" element={<div>invite-route</div>} />
      <Route path="/settings/:section" element={<DestinationRoute />} />
      <Route path="/extension-report" element={<DestinationRoute />} />
      <Route path="/reports/:report" element={<DestinationRoute />} />
      <Route path="/a/:slug" element={<DestinationRoute />} />
      <Route path="/https:/*" element={<DestinationRoute />} />
    </Routes>
  );
}

function renderLogin(path = "/login", strict = false) {
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <LoginRoutes />
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

const USER: User = { id: "u1", email: "u@example.com", displayName: "U", avatarUrl: null };
const PENDING_DESTINATION_KEY = "easytestdata:pending-destination";
const UNSAFE_DESTINATIONS = [
  "https://evil.example/x",
  "//evil.example",
  "/\\evil.example",
  "javascript:alert(1)",
  "data:text/html,test",
  "/login",
  "",
  "/login?next=/settings/team#members",
  "/LOGIN/",
  "/settings/../login",
  "/%6cogin",
  "/\t/evil.example",
  "/\n/evil.example",
  "%2F%2Fevil.example",
  "%2F%5Cevil.example",
  "%09https://evil.example",
  "%0Ahttps://evil.example"
];

beforeEach(() => {
  appConfig.deployment = "cloud";
  appConfig.enabledOAuthProviders = ["google", "github", "intuit"];
  authState.user = null;
  authState.exchangeOAuthCode.mockReset();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("LoginPage", () => {
  it("offers only the enabled providers, Intuit first", () => {
    renderLogin();
    const links = screen.getAllByRole("link", { name: /Continue with/ });
    expect(links.map((l) => l.textContent?.trim())).toEqual([
      "Continue with Intuit",
      "Continue with Google",
      "Continue with GitHub"
    ]);
    expect(links[0]).toHaveAttribute("href", "/api/v1/auth/intuit");
  });

  it("says it is free and open source, with a link to the code", () => {
    renderLogin();
    expect(screen.getByText(/Free and open source \(Apache-2.0\)/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Read the code on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/easytestdata/easytestdata"
    );
  });

  it("shows only the providers it knows, whatever the server lists", () => {
    appConfig.enabledOAuthProviders = ["google", "acme"];
    renderLogin();
    const links = screen.getAllByRole("link", { name: /Continue with/ });
    expect(links.map((l) => l.textContent?.trim())).toEqual(["Continue with Google"]);
  });

  it("says so when no provider is configured", () => {
    appConfig.enabledOAuthProviders = [];
    renderLogin();
    expect(screen.getByText(/No sign-in providers are configured/)).toBeInTheDocument();
  });

  it("exchanges an auth_code once under StrictMode", async () => {
    authState.exchangeOAuthCode.mockResolvedValue(undefined);
    renderLogin("/login?auth_code=oauth_abc", true);
    await waitFor(() => expect(authState.exchangeOAuthCode).toHaveBeenCalledWith("oauth_abc"));
    expect(authState.exchangeOAuthCode).toHaveBeenCalledTimes(1);
  });

  it("shows the error when the code exchange fails", async () => {
    authState.exchangeOAuthCode.mockRejectedValueOnce(
      new Error("OAuth code is invalid or expired")
    );
    renderLogin("/login?auth_code=bad");
    expect(await screen.findByText("OAuth code is invalid or expired")).toBeInTheDocument();
  });

  it("explains a refused sign-in from the server's error code", () => {
    renderLogin("/login?error=oauth_email_unverified");
    expect(screen.getByText(/has not verified your email address/)).toBeInTheDocument();
  });

  it("says so when the sign-in was cancelled at the provider", () => {
    renderLogin("/login?error=oauth_cancelled");
    expect(screen.getByText(/cancelled or declined at the provider/)).toBeInTheDocument();
  });

  it("goes home once signed in", async () => {
    authState.user = USER;
    renderLogin();
    expect(await screen.findByText("home-route")).toBeInTheDocument();
    expect(sessionStorage.length).toBe(0);
  });

  it("keeps the destination across the OAuth round trip and clears it after sign-in", async () => {
    const destination = "/settings/team?x=1#members";
    const first = renderLogin(`/login?next=${encodeURIComponent(destination)}`, true);
    expect(sessionStorage.getItem(PENDING_DESTINATION_KEY)).toBe(destination);
    first.unmount();

    authState.exchangeOAuthCode.mockResolvedValue(undefined);
    const returned = renderLogin("/login?auth_code=oauth_abc", true);
    await waitFor(() => expect(authState.exchangeOAuthCode).toHaveBeenCalledWith("oauth_abc"));
    authState.user = USER;
    returned.rerender(
      <StrictMode>
        <MemoryRouter>
          <LoginRoutes />
        </MemoryRouter>
      </StrictMode>
    );
    expect(await screen.findByText(destination)).toBeInTheDocument();
    expect(sessionStorage.length).toBe(0);
  });

  it.each(UNSAFE_DESTINATIONS)("ignores unsafe next parameter %j", async (destination) => {
    authState.user = USER;
    renderLogin(`/login?next=${encodeURIComponent(destination)}`);
    expect(await screen.findByText("home-route")).toBeInTheDocument();
    expect(sessionStorage.length).toBe(0);
  });

  it.each(UNSAFE_DESTINATIONS)("ignores unsafe stored destination %j", async (destination) => {
    sessionStorage.setItem(PENDING_DESTINATION_KEY, destination);
    authState.exchangeOAuthCode.mockResolvedValue(undefined);
    authState.user = USER;
    renderLogin("/login?auth_code=oauth_abc");
    expect(await screen.findByText("home-route")).toBeInTheDocument();
    expect(sessionStorage.length).toBe(0);
  });

  it.each([
    "/settings/team#urn:members",
    "/extension-report?url=https://example.com",
    "/reports/urn:daily",
    "/a/b:c?x=1#y"
  ])("keeps the same-origin destination %s from next and across OAuth", async (destination) => {
    const first = renderLogin(`/login?next=${encodeURIComponent(destination)}`);
    expect(sessionStorage.getItem(PENDING_DESTINATION_KEY)).toBe(destination);
    first.unmount();

    authState.exchangeOAuthCode.mockResolvedValue(undefined);
    authState.user = USER;
    renderLogin("/login?auth_code=oauth_abc");
    expect(await screen.findByText(destination)).toBeInTheDocument();
    expect(sessionStorage.length).toBe(0);
  });

  it("keeps a scheme-looking same-origin path from next and across OAuth", async () => {
    const destination = "/https://evil.example/x";
    const first = renderLogin(`/login?next=${encodeURIComponent(destination)}`);
    expect(sessionStorage.getItem(PENDING_DESTINATION_KEY)).toBe(destination);
    first.unmount();

    authState.exchangeOAuthCode.mockResolvedValue(undefined);
    authState.user = USER;
    renderLogin("/login?auth_code=oauth_abc");
    // React Router collapses repeated path slashes when navigating.
    expect(await screen.findByText("/https:/evil.example/x")).toBeInTheDocument();
    expect(sessionStorage.length).toBe(0);
  });

  it.each(["/settings/../settings/team?x=1#members", "/settings/\tteam?x=\n1#mem\rbers"])(
    "normalizes next and stored destinations before using them: %j",
    async (destination) => {
      const normalized = "/settings/team?x=1#members";
      const first = renderLogin(`/login?next=${encodeURIComponent(destination)}`);
      expect(sessionStorage.getItem(PENDING_DESTINATION_KEY)).toBe(normalized);
      first.unmount();

      // A value stored by an earlier login attempt is validated and normalized again.
      sessionStorage.setItem(PENDING_DESTINATION_KEY, destination);
      authState.exchangeOAuthCode.mockResolvedValue(undefined);
      authState.user = USER;
      renderLogin("/login?auth_code=oauth_abc");
      expect(await screen.findByText(normalized)).toBeInTheDocument();
      expect(sessionStorage.length).toBe(0);
    }
  );

  it("discards an abandoned destination on a later direct login visit", async () => {
    const abandoned = renderLogin("/login?next=%2Fsettings%2Fteam%3Fx%3D1");
    expect(sessionStorage.getItem(PENDING_DESTINATION_KEY)).toBe("/settings/team?x=1");
    abandoned.unmount();

    const direct = renderLogin();
    expect(sessionStorage.getItem(PENDING_DESTINATION_KEY)).toBeNull();
    direct.unmount();

    authState.exchangeOAuthCode.mockResolvedValue(undefined);
    authState.user = USER;
    renderLogin("/login?auth_code=oauth_abc");
    expect(await screen.findByText("home-route")).toBeInTheDocument();
    expect(sessionStorage.length).toBe(0);
  });

  it("keeps the destination after a provider error so sign-in can be retried", async () => {
    const destination = "/settings/team?x=1";
    sessionStorage.setItem(PENDING_DESTINATION_KEY, destination);
    const failed = renderLogin("/login?error=oauth_cancelled");
    expect(screen.getByText(/cancelled or declined at the provider/)).toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_DESTINATION_KEY)).toBe(destination);
    failed.unmount();

    authState.exchangeOAuthCode.mockResolvedValue(undefined);
    authState.user = USER;
    renderLogin("/login?auth_code=oauth_abc");
    expect(await screen.findByText(destination)).toBeInTheDocument();
    expect(sessionStorage.length).toBe(0);
  });

  it("returns to the invite after the OAuth round trip", async () => {
    authState.exchangeOAuthCode.mockResolvedValue(undefined);
    // Arrives from the invite link, then leaves for the provider.
    const first = renderLogin("/login?invite_token=inv_123");
    first.unmount();
    // Comes back from the provider with the code; the session is then established.
    authState.user = USER;
    renderLogin("/login?auth_code=oauth_abc");
    expect(await screen.findByText("invite-route")).toBeInTheDocument();
    expect(sessionStorage.length).toBe(0);
  });

  it("gives a pending invite priority over the destination and clears both", async () => {
    const first = renderLogin("/login?invite_token=inv_123&next=%2Fsettings%2Fteam%3Fx%3D1");
    first.unmount();
    authState.exchangeOAuthCode.mockResolvedValue(undefined);
    authState.user = USER;
    renderLogin("/login?auth_code=oauth_abc");
    expect(await screen.findByText("invite-route")).toBeInTheDocument();
    expect(sessionStorage.length).toBe(0);
  });

  it("shows the Terms line and the website link on Cloud only", () => {
    renderLogin();
    expect(screen.getByText("Back to website").closest("a")).toHaveAttribute(
      "href",
      "https://marketing.example"
    );
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute(
      "href",
      "https://marketing.example/legal/terms"
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    cleanup();

    appConfig.deployment = "local";
    renderLogin();
    expect(screen.queryByText("Back to website")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Terms" })).not.toBeInTheDocument();
  });

  it("shows the canonical tagline and an accurate sandbox-only note", () => {
    renderLogin();
    expect(
      screen.getByText("Realistic test data for QuickBooks Online sandboxes.")
    ).toBeInTheDocument();
    expect(
      screen.getByText(/never connects to a production QuickBooks company/)
    ).toBeInTheDocument();
  });
});

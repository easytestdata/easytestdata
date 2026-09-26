import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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

function renderLogin(path = "/login", strict = false) {
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/home" element={<div>home-route</div>} />
        <Route path="/invite" element={<div>invite-route</div>} />
      </Routes>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

const USER: User = { id: "u1", email: "u@example.com", displayName: "U", avatarUrl: null };

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

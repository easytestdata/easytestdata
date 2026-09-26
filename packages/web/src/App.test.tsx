import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { Outlet } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, connectErrorMessage } from "./App";

const authState = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; displayName: string; avatarUrl: null },
  loading: false,
  isAdmin: false
}));

const appConfig = vi.hoisted(() => ({
  loading: false,
  deployment: "cloud" as "cloud" | "local",
  sentryDsn: null,
  enabledOAuthProviders: [] as string[],
  version: "0.1.0",
  qboConfigured: true,
  qboRedirectUri: "http://localhost:3000/api/v1/connections/callback"
}));

vi.mock("@sentry/react", () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => children,
  init: vi.fn(),
  setUser: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn()
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
  useAppConfig: () => appConfig
}));

vi.mock("./contexts/AuthContext", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({
    ...authState,
    logout: vi.fn(),
    exchangeOAuthCode: vi.fn()
  })
}));

vi.mock("./components/Layout", () => ({
  Layout: () => <Outlet />
}));

vi.mock("./components/AdminLayout", () => ({
  AdminLayout: () => <Outlet />
}));

vi.mock("./pages/HomePage", () => ({
  HomePage: () => <div>home-page</div>
}));

vi.mock("./pages/SetupPage", () => ({
  SetupPage: () => <div>setup-page</div>
}));

vi.mock("./pages/SettingsPage", () => ({
  SettingsPage: () => <div>settings-page</div>
}));

vi.mock("./pages/admin/AdminDashboard", () => ({
  AdminDashboard: () => <div>admin-dashboard</div>
}));

function renderAt(path: string) {
  window.history.pushState({}, "", path);
  return render(<App />);
}

describe("App", () => {
  beforeEach(() => {
    authState.user = null;
    authState.isAdmin = false;
    appConfig.deployment = "cloud";
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders login screen for unauthenticated users", async () => {
    renderAt("/");

    expect(await screen.findByText("EasyTestData")).toBeInTheDocument();
  });

  it("never sends a local-mode visitor to the sign-in page", async () => {
    appConfig.deployment = "local";
    renderAt("/home");

    expect(await screen.findByText(/Could not reach the local EasyTestData server/)).toBeVisible();
    expect(window.location.pathname).toBe("/home");
  });

  it("sends invite links home in local mode (no teams or invites there)", async () => {
    appConfig.deployment = "local";
    authState.user = { id: "u1", email: "a@b.c", displayName: "A", avatarUrl: null };
    renderAt("/invite?token=abc");

    expect(await screen.findByText("home-page")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/home");
  });

  it("shows the Intuit keys setup page only in local mode", async () => {
    authState.user = { id: "u1", email: "a@b.c", displayName: "A", avatarUrl: null };
    appConfig.deployment = "local";
    renderAt("/setup");
    expect(await screen.findByText("setup-page")).toBeInTheDocument();
    cleanup();

    appConfig.deployment = "cloud";
    renderAt("/setup");
    expect(await screen.findByText("home-page")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/home");
  });

  it("maps ?error= codes to messages and never echoes unknown values", () => {
    expect(connectErrorMessage("state_invalid")).toMatch(/connection link expired/);
    expect(connectErrorMessage("connect_cancelled")).toMatch(/cancelled or declined/);
    expect(connectErrorMessage("<script>alert(1)</script>")).toBe(
      "Something went wrong. Please try again."
    );
    expect(connectErrorMessage("toString")).toBe("Something went wrong. Please try again.");
  });

  it("sends an unknown path home", async () => {
    authState.user = { id: "u1", email: "a@b.c", displayName: "A", avatarUrl: null };
    renderAt("/no-such-page");

    expect(await screen.findByText("home-page")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/home");
  });

  it("explains the Cloud connection limit", () => {
    expect(connectErrorMessage("connection_limit_reached")).toBe(
      "EasyTestData Cloud allows up to 3 QuickBooks connections per team. Run it locally for no limits."
    );
  });
});

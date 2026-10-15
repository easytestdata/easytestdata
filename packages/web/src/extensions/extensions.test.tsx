import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extensions from "@easytestdata/web-extensions";
import { App } from "../App";
import { brand } from "../brand";
import type { WebExtensions } from "./types";

const authState = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; displayName: string; avatarUrl: null },
  loading: false,
  isAdmin: false
}));
const lazyRoute = vi.hoisted(() => ({
  started: vi.fn(),
  resolve: null as null | (() => void)
}));

vi.mock("@easytestdata/web-extensions", async () => {
  const { lazy } = await import("react");
  const { ChartNoAxesCombined } = await import("lucide-react");
  const ReportsPage = lazy(() => {
    lazyRoute.started();
    return new Promise<{ default: () => ReactNode }>((resolve) => {
      lazyRoute.resolve = () => resolve({ default: () => <div>lazy-reports-page</div> });
    });
  });
  return {
    default: {
      logo: ({ className }) => <svg aria-label="Extension logo" className={className} />,
      routes: [
        { path: "/reports", element: () => <div>reports-page</div> },
        { path: "/reports/lazy", element: ReportsPage }
      ],
      navItems: [{ path: "/reports", label: "Reports", icon: ChartNoAxesCombined }]
    } satisfies WebExtensions
  };
});
vi.mock("@easytestdata/web-brand", () => ({
  default: {
    name: "Example app",
    description: "Example description",
    repoUrl: null,
    supportsSourceReads: true,
    companionUrl: "https://example.com",
    companionLabel: "Companion"
  }
}));
vi.mock("../contexts/SentryContext", () => ({
  SentryProvider: ({ children }: { children: ReactNode }) => children,
  SentryErrorBoundary: ({ children }: { children: ReactNode }) => children
}));
vi.mock("../contexts/AppConfigContext", () => ({
  AppConfigProvider: ({ children }: { children: ReactNode }) => children,
  useAppConfig: () => ({ loading: false, deployment: "cloud" })
}));
vi.mock("../contexts/AuthContext", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ ...authState, logout: vi.fn() })
}));
vi.mock("../pages/LoginPage", () => ({ LoginPage: () => <div>login-page</div> }));
vi.mock("../pages/HomePage", () => ({ HomePage: () => <div>home-page</div> }));
vi.mock("../pages/SettingsPage", () => ({ SettingsPage: () => <div>settings-page</div> }));
vi.mock("../pages/SetupPage", () => ({ SetupPage: () => <div>setup-page</div> }));

function renderAt(path: string) {
  window.history.pushState({}, "", path);
  return render(<App />);
}

beforeEach(() => {
  authState.user = null;
  authState.loading = false;
  lazyRoute.started.mockClear();
});
afterEach(cleanup);

describe("web extensions", () => {
  it("keeps the bundled fixture paths unique and outside built-in routes", () => {
    for (const items of [extensions.routes, extensions.navItems]) {
      const paths = items.map((item) => item.path);
      expect(new Set(paths).size).toBe(paths.length);
      for (const path of paths) {
        expect(path).toMatch(/^\//);
        expect(path).not.toMatch(
          /^\/(?:$|home(?:\/|$)|settings(?:\/|$)|setup(?:\/|$)|login(?:\/|$)|invite(?:\/|$)|admin(?:\/|$))/
        );
        expect(path).not.toContain("*");
      }
    }
    for (const item of extensions.navItems) {
      expect(extensions.routes.some((route) => route.path === item.path)).toBe(true);
    }
  });

  it.each(["/reports", "/reports/lazy"])("requires authentication for %s", async (path) => {
    renderAt(path);
    expect(await screen.findByText("login-page")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
    expect(screen.queryByRole("main")).not.toBeInTheDocument();
    expect(lazyRoute.started).not.toHaveBeenCalled();
  });

  it("loads a lazy route inside the actual protected Layout with its loading fallback", async () => {
    authState.user = { id: "u1", email: "u@example.com", displayName: "U Ser", avatarUrl: null };
    renderAt("/reports/lazy");

    expect(screen.getByRole("main").querySelector(".animate-spin")).toBeInTheDocument();
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(lazyRoute.started).toHaveBeenCalledOnce();
    await act(async () => lazyRoute.resolve!());
    expect(await within(screen.getByRole("main")).findByText("lazy-reports-page")).toBeVisible();
    expect(window.location.pathname).toBe("/reports/lazy");
  });

  it("appends desktop navigation and opens the extension route", async () => {
    authState.user = { id: "u1", email: "u@example.com", displayName: "U Ser", avatarUrl: null };
    renderAt("/home");

    const nav = screen.getByRole("navigation");
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent)
    ).toEqual(["Home", "Settings", "Reports"]);
    fireEvent.click(within(nav).getByRole("link", { name: "Reports" }));
    expect(await within(screen.getByRole("main")).findByText("reports-page")).toBeVisible();
    expect(window.location.pathname).toBe("/reports");
  });

  it("appends mobile navigation and closes the Sheet when its link is selected", async () => {
    authState.user = { id: "u1", email: "u@example.com", displayName: "U Ser", avatarUrl: null };
    renderAt("/home");
    fireEvent.click(screen.getByRole("button", { name: "Open navigation menu" }));

    const mobile = screen.getByRole("dialog");
    expect(within(mobile).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/home");
    expect(within(mobile).getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings"
    );
    fireEvent.click(within(mobile).getByRole("link", { name: "Reports" }));

    expect(await within(screen.getByRole("main")).findByText("reports-page")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/reports");
  });

  it("exports the selected metadata and uses an extension logo when supplied", () => {
    expect(brand).toEqual({
      name: "Example app",
      description: "Example description",
      repoUrl: null,
      supportsSourceReads: true,
      companionUrl: "https://example.com",
      companionLabel: "Companion",
      logo: extensions.logo
    });
    const Logo = brand.logo;
    render(<Logo className="h-8 w-8" />);
    expect(screen.getByLabelText("Extension logo")).toHaveClass("h-8", "w-8");
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// A build whose brand turns teams off (one person per login) and whose extension module supplies
// public pages: Settings has no Team section, and a public path outside /p/ is refused when the
// app loads. (/invite going home is covered in extensions.test.tsx, which renders the whole app.)
const extensionModule = vi.hoisted(() => ({
  value: {
    routes: [] as { path: string; element: () => null }[],
    navItems: [],
    publicRoutes: [] as { path: string; element: () => null }[]
  }
}));
vi.mock("@easytestdata/web-brand", () => ({
  default: {
    name: "Example app",
    description: "Example description",
    repoUrl: null,
    supportsSourceReads: true,
    teams: false
  }
}));
vi.mock("@easytestdata/web-extensions", () => ({
  get default() {
    return extensionModule.value;
  }
}));
vi.mock("@/contexts/AppConfigContext", () => ({
  AppConfigProvider: ({ children }: { children: ReactNode }) => children,
  useAppConfig: () => ({ loading: false, deployment: "cloud" })
}));
vi.mock("@/components/settings/AccountSection", () => ({
  AccountSection: () => <div>account</div>
}));
vi.mock("@/components/settings/TeamSection", () => ({ TeamSection: () => <div>team</div> }));
vi.mock("@/components/settings/AboutSection", () => ({ AboutSection: () => <div>about</div> }));

afterEach(cleanup);

describe("brand.teams = false", () => {
  it("hides the Team section and sends /settings/team back to /settings", async () => {
    const { SettingsPage } = await import("../pages/SettingsPage");
    render(
      <MemoryRouter initialEntries={["/settings/team"]}>
        <Routes>
          <Route path="/settings" element={<div>settings-root</div>} />
          <Route path="/settings/:section" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByText("settings-root")).toBeTruthy();
    render(
      <MemoryRouter initialEntries={["/settings/about"]}>
        <Routes>
          <Route path="/settings/:section" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.queryByRole("button", { name: /Team/ })).toBeNull();
    expect(screen.getByRole("button", { name: /About/ })).toBeTruthy();
  });
});

describe("public extension routes", () => {
  it.each(["/p/", "/p/connect", "/P/Connect"])("accepts the public path %s", async (path) => {
    vi.resetModules();
    extensionModule.value = {
      routes: [],
      navItems: [],
      publicRoutes: [{ path, element: () => null }]
    };
    await expect(import("../App")).resolves.toHaveProperty("App");
  });

  it("refuses a public path that does not start with /p/", async () => {
    vi.resetModules();
    extensionModule.value = {
      routes: [],
      navItems: [],
      publicRoutes: [{ path: "/connect", element: () => null }]
    };
    await expect(import("../App")).rejects.toThrow(
      "Public extension route /connect must start with /p/"
    );
  });

  it.each(["/p/connect", "/p", "/p/:slug", "/P/connect", "/P"])(
    "refuses a signed-in extension route at %s",
    async (path) => {
      vi.resetModules();
      extensionModule.value = {
        routes: [{ path, element: () => null }],
        navItems: [],
        publicRoutes: [{ path: "/p/connect", element: () => null }]
      };
      await expect(import("../App")).rejects.toThrow(`Extension route ${path} must not use /p/`);
    }
  );
});

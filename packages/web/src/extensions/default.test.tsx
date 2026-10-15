import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BrandLogo, REPO_URL } from "@easytestdata/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brand } from "../brand";
import { Layout } from "../components/Layout";
import extensions from "./default";

vi.mock("../contexts/AppConfigContext", () => ({
  useAppConfig: () => ({ deployment: "cloud" })
}));
vi.mock("../contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "u1", email: "u@example.com", displayName: "U Ser", avatarUrl: null },
    isAdmin: false,
    logout: vi.fn()
  })
}));

afterEach(cleanup);

describe("public web defaults", () => {
  it("provides no extension routes, navigation or logo", () => {
    expect(extensions.routes).toEqual([]);
    expect(extensions.navItems).toEqual([]);
    expect(extensions.logo).toBeUndefined();
  });

  it("keeps today's metadata and falls back to the shared logo", () => {
    expect(brand).toEqual({
      name: "EasyTestData",
      description: "Realistic test data for QuickBooks Online sandboxes.",
      repoUrl: REPO_URL,
      supportsSourceReads: false,
      logo: BrandLogo
    });
  });

  it("preserves Home and Settings in the desktop and mobile menus", () => {
    render(
      <MemoryRouter initialEntries={["/home"]}>
        <Layout />
      </MemoryRouter>
    );

    const desktop = screen.getByRole("navigation");
    expect(
      within(desktop)
        .getAllByRole("link")
        .map((link) => link.textContent)
    ).toEqual(["Home", "Settings"]);
    expect(within(desktop).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/home");
    expect(within(desktop).getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings"
    );

    fireEvent.click(screen.getByRole("button", { name: "Open navigation menu" }));
    const mobile = screen.getByRole("dialog");
    expect(
      within(mobile)
        .getAllByRole("link")
        .map((link) => link.textContent)
    ).toEqual(["Home", "Settings", "Open source (Apache-2.0)"]);
    expect(within(mobile).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/home");
    expect(within(mobile).getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings"
    );
  });
});

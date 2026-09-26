import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";

const appConfig = vi.hoisted(() => ({ deployment: "cloud" as "cloud" | "local" }));
vi.mock("@/contexts/AppConfigContext", () => ({ useAppConfig: () => appConfig }));
vi.mock("@/components/settings/AccountSection", () => ({
  AccountSection: () => <div>account-section</div>
}));
vi.mock("@/components/settings/TeamSection", () => ({
  TeamSection: () => <div>team-section</div>
}));
vi.mock("@/components/settings/AboutSection", () => ({
  AboutSection: () => <div>about-section</div>
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/:section" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function tabLabels() {
  return screen
    .getAllByRole("button")
    .map((b) => b.textContent)
    .filter(Boolean);
}

describe("SettingsPage", () => {
  afterEach(() => {
    cleanup();
    appConfig.deployment = "cloud";
  });

  it("has no Team tab in local mode (one built-in user and team)", () => {
    appConfig.deployment = "local";
    renderAt("/settings");
    expect(tabLabels()).toEqual(["Account", "About"]);
    cleanup();

    renderAt("/settings/team");
    expect(screen.getByText("account-section")).toBeInTheDocument();
    expect(screen.queryByText("team-section")).not.toBeInTheDocument();
  });

  it("shows the Account, Team and About tabs", () => {
    renderAt("/settings");
    expect(tabLabels()).toEqual(["Account", "Team", "About"]);
    expect(screen.getByText("account-section")).toBeInTheDocument();
  });

  it("opens a section from its URL", () => {
    renderAt("/settings/about");
    expect(screen.getByText("about-section")).toBeInTheDocument();
  });

  it("redirects unknown sections to Account", () => {
    renderAt("/settings/nope");
    expect(screen.getByText("account-section")).toBeInTheDocument();
  });
});

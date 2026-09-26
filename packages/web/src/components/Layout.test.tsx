import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Layout } from "./Layout";

const appConfig = vi.hoisted(() => ({ deployment: "cloud" as "cloud" | "local" }));
vi.mock("../contexts/AppConfigContext", () => ({ useAppConfig: () => appConfig }));
vi.mock("../contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "u1", email: "u@example.com", displayName: "U Ser", avatarUrl: null },
    isAdmin: false,
    logout: vi.fn()
  })
}));

function openMenu() {
  render(
    <MemoryRouter initialEntries={["/home"]}>
      <Layout />
    </MemoryRouter>
  );
  fireEvent.click(screen.getByRole("button", { name: "Open navigation menu" }));
}

describe("Layout", () => {
  afterEach(() => {
    cleanup();
    appConfig.deployment = "cloud";
  });

  it("offers Sign out on EasyTestData Cloud", () => {
    openMenu();
    expect(screen.getByRole("button", { name: /Sign out/ })).toBeInTheDocument();
  });

  it("has nothing to sign out of in local mode", () => {
    appConfig.deployment = "local";
    openMenu();
    expect(screen.getByText("u@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sign out/ })).not.toBeInTheDocument();
  });
});

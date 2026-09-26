import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AboutSection } from "./AboutSection";

const appConfig = vi.hoisted(() => ({
  version: "0.1.0",
  deployment: "local" as "cloud" | "local",
  qboConfigured: false,
  qboRedirectUri: "https://etd.example.com/api/v1/connections/callback"
}));

vi.mock("@/contexts/AppConfigContext", () => ({
  useAppConfig: () => appConfig
}));

describe("AboutSection", () => {
  beforeEach(() => {
    appConfig.deployment = "local";
    appConfig.qboConfigured = false;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows version, API status, mode and project links", async () => {
    render(<AboutSection />);

    expect(screen.getByText("0.1.0")).toBeInTheDocument();
    expect(await screen.findByText("Reachable")).toBeInTheDocument();
    expect(screen.getAllByText("Local").length).toBeGreaterThan(0);
    expect(
      screen.getByText("Realistic test data for QuickBooks Online sandboxes.")
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /GitHub repository/ })).toHaveAttribute(
      "href",
      "https://github.com/easytestdata/easytestdata"
    );
    expect(screen.getByRole("link", { name: /Run it locally/ })).toHaveAttribute(
      "href",
      "https://github.com/easytestdata/easytestdata/blob/main/docs/run-locally.md"
    );
    expect(screen.getByRole("link", { name: /Report an issue/ })).toBeInTheDocument();
    // Same headers as every other API call (local mode's cross-site guard).
    expect(fetch).toHaveBeenCalledWith("/api/v1/config/public", {
      headers: { "X-EasyTestData": "1" }
    });
  });

  it("shows the Intuit redirect URI to copy in local mode", async () => {
    render(<AboutSection />);

    expect(screen.getByText(appConfig.qboRedirectUri)).toBeInTheDocument();
    expect(screen.getByText("Not configured")).toBeInTheDocument();
    await screen.findByText("Reachable");
  });

  it("does not show the redirect URI on EasyTestData Cloud", async () => {
    appConfig.deployment = "cloud";
    appConfig.qboConfigured = true;
    render(<AboutSection />);

    expect(screen.queryByText(appConfig.qboRedirectUri)).not.toBeInTheDocument();
    expect(screen.getAllByText("EasyTestData Cloud").length).toBeGreaterThan(0);
    await screen.findByText("Reachable");
  });
});

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppConfigProvider, useAppConfig } from "./AppConfigContext";

const getPublicConfigMock = vi.hoisted(() => vi.fn());
vi.mock("../api/client", () => ({
  getPublicConfig: (...args: unknown[]) => getPublicConfigMock(...args)
}));

const base = {
  version: "1.0.0",
  sentryDsn: null,
  deployment: "local",
  enabledOAuthProviders: [],
  qboRedirectUri: "http://localhost:28080/api/v1/connections/callback"
};

let latest: ReturnType<typeof useAppConfig> | null = null;
function Probe() {
  latest = useAppConfig();
  return <div>{latest.qboConfigured ? "configured" : "not-configured"}</div>;
}

describe("AppConfigProvider", () => {
  afterEach(() => cleanup());

  it("refresh() re-fetches /config/public and updates the value", async () => {
    getPublicConfigMock.mockResolvedValueOnce({ ...base, qboConfigured: false });
    render(
      <AppConfigProvider>
        <Probe />
      </AppConfigProvider>
    );
    expect(await screen.findByText("not-configured")).toBeInTheDocument();

    getPublicConfigMock.mockResolvedValueOnce({ ...base, qboConfigured: true });
    await act(async () => {
      await latest!.refresh();
    });
    await waitFor(() => expect(screen.getByText("configured")).toBeInTheDocument());
    expect(getPublicConfigMock).toHaveBeenCalledTimes(2);
  });

  it("refresh() rejects when the fetch fails and keeps the current values", async () => {
    getPublicConfigMock.mockResolvedValueOnce({ ...base, qboConfigured: false });
    render(
      <AppConfigProvider>
        <Probe />
      </AppConfigProvider>
    );
    expect(await screen.findByText("not-configured")).toBeInTheDocument();

    getPublicConfigMock.mockRejectedValueOnce(new Error("Failed to load public config"));
    await act(async () => {
      await expect(latest!.refresh()).rejects.toThrow("Failed to load public config");
    });
    expect(screen.getByText("not-configured")).toBeInTheDocument();
  });

  it("keeps the defaults (no unhandled rejection) when the first load fails", async () => {
    getPublicConfigMock.mockRejectedValueOnce(new Error("offline"));
    render(
      <AppConfigProvider>
        <Probe />
      </AppConfigProvider>
    );
    await waitFor(() => expect(latest!.loading).toBe(false));
    expect(latest!.deployment).toBe("cloud");
  });
});

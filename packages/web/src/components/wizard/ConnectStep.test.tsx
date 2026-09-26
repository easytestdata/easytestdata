import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectStep } from "@easytestdata/ui";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}));

const connection = {
  id: "conn-1",
  realm_id: "realm-1",
  company_name: "Sandbox Co",
  base_url: "https://sandbox-quickbooks.api.intuit.com",
  connected_at: "2026-07-08T10:00:00.000Z",
  last_used_at: null
};

describe("ConnectStep", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps connection removal pending until the delete request settles", async () => {
    let resolveDelete!: () => void;
    const onDeleteConnection = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        })
    );

    render(
      <ConnectStep
        connections={[connection]}
        onConnected={vi.fn()}
        onDeleteConnection={onDeleteConnection}
        onTestConnection={vi.fn()}
        onAuthorizeConnection={vi.fn()}
        onConnectionsInvalidate={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Sandbox Co" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(onDeleteConnection).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Disconnecting..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Disconnecting..." }));
    expect(onDeleteConnection).toHaveBeenCalledTimes(1);

    resolveDelete();

    await waitFor(() => {
      expect(screen.queryByText("Disconnect this sandbox?")).not.toBeInTheDocument();
    });
  });

  it("treats a sandbox the detailed health check found expired as expired", () => {
    render(
      <ConnectStep
        connections={[{ ...connection, id: "young", company_name: "Young Co", tokenHealth: "ok" }]}
        onConnected={vi.fn()}
        onDeleteConnection={vi.fn()}
        onTestConnection={vi.fn()}
        onAuthorizeConnection={vi.fn()}
        onConnectionsInvalidate={vi.fn()}
        expiredConnectionIds={new Set(["young"])}
      />
    );
    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("sends Reconnect to setup in local mode when the Intuit keys are missing", () => {
    render(
      <ConnectStep
        connections={[{ ...connection, id: "dead", company_name: "Stale Co", tokenHealth: "expired" }]}
        onConnected={vi.fn()}
        onDeleteConnection={vi.fn()}
        onTestConnection={vi.fn()}
        onAuthorizeConnection={vi.fn()}
        onConnectionsInvalidate={vi.fn()}
        qboConfigured={false}
        setupHref="/setup"
      />
    );
    expect(screen.getByRole("link", { name: "Reconnect" })).toHaveAttribute("href", "/setup");
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  });

  it("shows each sandbox's token health instead of a blanket Connected badge", () => {
    render(
      <ConnectStep
        connections={[
          { ...connection, id: "ok", company_name: "Fresh Co", tokenHealth: "ok" },
          { ...connection, id: "warn", company_name: "Aging Co", tokenHealth: "warning" },
          { ...connection, id: "dead", company_name: "Stale Co", tokenHealth: "expired" }
        ]}
        onConnected={vi.fn()}
        onDeleteConnection={vi.fn()}
        onTestConnection={vi.fn()}
        onAuthorizeConnection={vi.fn()}
        onConnectionsInvalidate={vi.fn()}
      />
    );

    expect(screen.getAllByText("Connected")).toHaveLength(1);
    expect(screen.getByText("Token expiring soon")).toBeInTheDocument();
    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(
      screen.getByText("Click Reconnect and pick this company in Intuit before loading data.")
    ).toBeInTheDocument();
    // An expired sandbox has a way forward, not just a red badge.
    expect(screen.getAllByRole("button", { name: "Reconnect" })).toHaveLength(1);
  });

  it("offers a clearly visible option to generate and download sample data", () => {
    const onSkipToGenerate = vi.fn();
    render(
      <ConnectStep
        connections={[]}
        onConnected={vi.fn()}
        onSkipToGenerate={onSkipToGenerate}
        onDeleteConnection={vi.fn()}
        onTestConnection={vi.fn()}
        onAuthorizeConnection={vi.fn()}
        onConnectionsInvalidate={vi.fn()}
      />
    );

    expect(screen.getByText("No QuickBooks sandbox yet?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Make sample files instead" }));
    expect(onSkipToGenerate).toHaveBeenCalledTimes(1);
  });

  it("explains how to configure QBO instead of offering a broken connect button", () => {
    const onAuthorizeConnection = vi.fn();
    render(
      <ConnectStep
        connections={[]}
        onConnected={vi.fn()}
        onSkipToGenerate={vi.fn()}
        onDeleteConnection={vi.fn()}
        onTestConnection={vi.fn()}
        onAuthorizeConnection={onAuthorizeConnection}
        onConnectionsInvalidate={vi.fn()}
        qboConfigured={false}
        qboRedirectUri="https://etd.example.com/api/v1/connections/callback"
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("QuickBooks Online is not configured");
    expect(screen.getByRole("alert")).toHaveTextContent("QBO_CLIENT_ID");
    expect(
      screen.getByText("https://etd.example.com/api/v1/connections/callback")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect QuickBooks Sandbox" })
    ).not.toBeInTheDocument();
    // Sample data stays available without QBO.
    expect(
      screen.getByRole("button", { name: "Make sample files instead" })
    ).toBeInTheDocument();
  });

  it("opens the setup page instead of Intuit when keys are missing and setupHref is given", () => {
    const onAuthorizeConnection = vi.fn();
    const props = {
      onConnected: vi.fn(),
      onDeleteConnection: vi.fn(),
      onTestConnection: vi.fn(),
      onAuthorizeConnection,
      onConnectionsInvalidate: vi.fn(),
      qboConfigured: false,
      setupHref: "/setup"
    };
    const { unmount } = render(<ConnectStep connections={[]} {...props} />);

    const connect = screen.getByRole("link", { name: /Connect QuickBooks Sandbox/ });
    expect(connect).toHaveAttribute("href", "/setup");
    // No "set environment variables" instructions: the setup page takes the keys.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    unmount();

    render(<ConnectStep connections={[connection]} {...props} />);
    expect(screen.getByRole("link", { name: /Add another sandbox/ })).toHaveAttribute(
      "href",
      "/setup"
    );
    expect(onAuthorizeConnection).not.toHaveBeenCalled();
  });

  it("shows the server's error when authorization fails", async () => {
    const { toast } = await import("sonner");
    const onAuthorizeConnection = vi
      .fn()
      .mockRejectedValue(new Error("QuickBooks Online is not configured on this server."));
    render(
      <ConnectStep
        connections={[]}
        onConnected={vi.fn()}
        onDeleteConnection={vi.fn()}
        onTestConnection={vi.fn()}
        onAuthorizeConnection={onAuthorizeConnection}
        onConnectionsInvalidate={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect QuickBooks Sandbox" }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "QuickBooks Online is not configured on this server."
      );
    });
  });

  it("describes a popup error code (e.g. the connection limit) instead of showing the code", async () => {
    const { toast } = await import("sonner");
    render(
      <ConnectStep
        connections={[]}
        onConnected={vi.fn()}
        onDeleteConnection={vi.fn()}
        onTestConnection={vi.fn()}
        onAuthorizeConnection={vi.fn()}
        onConnectionsInvalidate={vi.fn()}
        describeConnectError={(code) => `described:${code}`}
      />
    );

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: { error: "connection_limit_reached" }
      })
    );

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("described:connection_limit_reached");
    });
  });

  it("shows the server's reason when removing a connection is refused", async () => {
    const { toast } = await import("sonner");
    const onDeleteConnection = vi
      .fn()
      .mockRejectedValue(new Error("A job is queued or running on this sandbox."));
    render(
      <ConnectStep
        connections={[connection]}
        onConnected={vi.fn()}
        onDeleteConnection={onDeleteConnection}
        onTestConnection={vi.fn()}
        onAuthorizeConnection={vi.fn()}
        onConnectionsInvalidate={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Sandbox Co" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("A job is queued or running on this sandbox.");
    });
  });
});
